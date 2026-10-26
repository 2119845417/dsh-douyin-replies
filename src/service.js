import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { normalized, profileUrl, validateAdapter, validateSettings, videoUrl } from './domain.js'
import { exclusion, generationContext, preferences, updatePreferences, validateReply } from './preferences.js'

export class Service {
  constructor(store, browser) { this.store = store; this.browser = browser; this.tail = Promise.resolve(); this.stopping = false }

  exclusive(operation, signal) {
    const task = this.tail.then(async () => {
      if (this.stopping) throw new Error('插件正在卸载。')
      signal?.throwIfAborted()
      const cancel = () => { void this.browser.cancelPage() }
      signal?.addEventListener('abort', cancel, { once: true })
      try { return await operation() } finally { signal?.removeEventListener('abort', cancel) }
    })
    this.tail = task.catch(() => {})
    return task
  }

  settings() {
    const value = this.store.data.settings
    if (!value) throw new Error('请先运行 douyin_setup 配置账号及视频列表。')
    return value
  }

  adapter() {
    if (!this.store.data.adapter) throw new Error('请先检查真实页面，并用 douyin_calibrate 校准 CSS 选择器。')
    return this.store.data.adapter
  }

  allowedVideo(input) {
    const canonical = videoUrl(input)
    if (!this.settings().videos.includes(canonical)) throw new Error('视频不在已配置的任务列表中。')
    return canonical
  }

  async setup(input) {
    const settings = validateSettings(input)
    const previous = this.store.data.settings
    if (previous && previous.ownerProfileUrl !== settings.ownerProfileUrl) {
      if (Object.values(this.store.data.comments).some(item => ['sending', 'uncertain', 'ready', 'draft'].includes(item.status))) throw new Error('存在未结束任务，不能切换账号。请为另一个账号使用独立状态目录。')
      // Account identity is part of the ledger scope; do not reuse its dedup keys.
      throw new Error('更换账号需使用独立 DSH_DOUYIN_HOME。')
    }
    if (previous?.channel !== undefined && previous.channel !== settings.channel && this.browser.context) throw new Error('更改浏览器 channel 前请重启插件。')
    this.store.data.settings = settings
    await this.store.save()
    return { settings, stateDirectory: this.store.directory, next: '运行 douyin_open_browser，在打开的独立窗口登录。' }
  }

  async open(input = {}) {
    const settings = this.settings()
    const url = input.video ? this.allowedVideo(input.video) : settings.videos[0]
    return this.browser.open(settings, url)
  }

  async inspect(selector) { return this.browser.inspect(selector) }
  async screenshot() { return this.browser.screenshot(join(this.store.directory, 'browser-latest.png')) }

  async setPreferences(patch) {
    const next = updatePreferences(this.store.data.preferences, patch)
    if (JSON.stringify(next) === JSON.stringify(preferences(this.store.data.preferences))) return { ...this.replyContext(), affected: [], note: '设置未变化，保留已有队列。' }
    this.store.data.preferences = next
    this.store.data.preferenceRevision = (this.store.data.preferenceRevision ?? 0) + 1
    const affected = []
    for (const item of Object.values(this.store.data.comments)) {
      const reason = exclusion(item, next)
      if (reason && ['new', 'draft', 'ready'].includes(item.status)) {
        item.status = 'skipped'; item.skipSource = 'filter'; item.reason = reason; affected.push(item.key)
      } else if (!reason && item.status === 'skipped' && item.skipSource === 'filter') {
        item.status = 'new'; item.reply = null; item.reason = null; delete item.skipSource; affected.push(item.key)
      } else if (item.status === 'ready') {
        item.status = 'draft'; item.reason = '人格或回复规则已修改，请按新设置检查草稿后重新设为 ready。'; affected.push(item.key)
      }
    }
    await this.store.save()
    return { ...this.replyContext(), affected, note: '已保存。人格语气与类别过滤交由模型判断；硬性过滤和长度限制由代码校验。已有 ready 草稿已降为 draft，不能沿用旧设置直接发送。' }
  }

  replyContext(key) {
    const config = preferences(this.store.data.preferences)
    const context = { ...generationContext(config), revision: this.store.data.preferenceRevision ?? 0 }
    if (key) {
      const item = this.store.data.comments[key]
      if (!item) throw new Error('找不到评论，请先扫描。')
      context.comment = { key: item.key, video: item.video, author: item.author, text: item.text, status: item.status }
      context.excludedReason = exclusion(item, config)
    }
    return context
  }

  async calibrate(input) {
    const adapter = validateAdapter(input)
    const video = videoUrl(this.browser.page?.url() ?? '')
    this.allowedVideo(video)
    const scan = await this.browser.scan(this.settings(), adapter, video)
    if (!scan.comments.length) throw new Error('未识别到唯一的可见顶层评论，选择器未保存。请展开评论并检查实际 DOM。')
    this.store.data.adapter = adapter
    await this.store.save()
    return { calibrated: true, sample: scan.comments.slice(0, 5), ambiguous: scan.ambiguous, note: '选择器已通过读取校验；首次发送前仍需验证回复输入框和发送按钮。' }
  }

  async scan(input = {}, signal) {
    const settings = this.settings()
    const videos = input.video ? [this.allowedVideo(input.video)] : settings.videos
    const results = []
    for (const video of videos) {
      signal?.throwIfAborted()
      try {
        const found = await this.browser.scan(settings, this.adapter(), video, { scroll: input.scroll ?? false })
        const rows = []
        for (const comment of found.comments) {
          let ownComment = false
          try { ownComment = profileUrl(comment.authorUrl) === settings.ownerProfileUrl } catch {}
          const ownReply = comment.ownReplies.some(reply => { try { return profileUrl(reply.authorUrl) === settings.ownerProfileUrl } catch { return false } })
          const previous = this.store.data.comments[comment.key]
          if (previous) {
            if (previous.author !== comment.author || previous.text !== comment.text) {
              if (['new', 'draft', 'ready'].includes(previous.status)) { previous.status = 'changed'; previous.reason = '评论作者或正文变化，旧草稿已停用。' }
            }
            rows.push({ key: previous.key, author: previous.author, text: previous.text, status: previous.status })
            continue
          }
          const filtered = exclusion(comment, this.store.data.preferences)
          const item = { key: comment.key, video, domId: comment.domId, author: comment.author, authorUrl: comment.authorUrl, text: comment.text, status: ownComment || ownReply || filtered ? 'skipped' : 'new', reason: ownComment ? '账号自己的评论' : ownReply ? '页面已显示自己的回复' : filtered, discoveredAt: Date.now(), reply: null }
          if (filtered && !ownComment && !ownReply) item.skipSource = 'filter'
          this.store.data.comments[item.key] = item
          rows.push({ key: item.key, author: item.author, text: item.text, status: item.status })
        }
        await this.store.save()
        results.push({ video, ok: true, comments: rows, ambiguous: found.ambiguous, coverage: '仅当前已加载且可见的顶层评论；不代表评论区全部内容。' })
      } catch (error) { signal?.throwIfAborted(); results.push({ video, ok: false, error: error.message }) }
    }
    return { videos: results }
  }

  async draft(key, reply, ready = false, revision) {
    const item = this.store.data.comments[key]
    if (!item) throw new Error('找不到评论，请先扫描。')
    this.allowedVideo(item.video)
    if (!['new', 'draft', 'ready'].includes(item.status)) throw new Error(`评论当前状态 ${item.status}，不能覆写草稿或重新发送。`)
    const currentRevision = this.store.data.preferenceRevision ?? 0
    if (currentRevision > 0 && revision !== currentRevision) throw new Error('请先读取 douyin_reply_context，再使用返回的 revision 保存草稿；不能跳过已保存的人格规则。')
    const filtered = exclusion(item, this.store.data.preferences)
    if (filtered) throw new Error(filtered)
    const config = preferences(this.store.data.preferences)
    const value = validateReply(reply ?? '', config, this.settings())
    if (value === item.text) throw new Error('回复与原评论完全相同，请重新生成。')
    item.reply = value
    item.preferenceRevision = currentRevision
    item.status = ready ? 'ready' : 'draft'
    item.reason = null
    item.draftedAt = Date.now()
    await this.store.save()
    return { key, status: item.status, reply: item.reply, revision: currentRevision, video: item.video, author: item.author, text: item.text }
  }

  async send({ keys, limit } = {}, signal) {
    signal?.throwIfAborted()
    const settings = this.settings()
    const adapter = this.adapter()
    const cap = limit ?? settings.maxRepliesPerRun
    if (!Number.isInteger(cap) || cap < 1 || cap > settings.maxRepliesPerRun) throw new Error('limit 超出 maxRepliesPerRun。')
    if (keys && (!Array.isArray(keys) || keys.some(key => typeof key !== 'string'))) throw new Error('keys 必须是评论 key 数组。')
    const requested = keys ? [...new Set(keys)].map(key => {
      const item = this.store.data.comments[key]
      if (!item) throw new Error(`找不到评论：${key}`)
      return item
    }) : Object.values(this.store.data.comments).filter(item => item.status === 'ready' && settings.videos.includes(item.video))
    const items = requested.slice(0, cap)
    const results = []
    for (const item of items) {
      signal?.throwIfAborted()
      this.allowedVideo(item.video)
      if (item.status !== 'ready') { results.push({ key: item.key, status: item.status, skipped: true }); continue }
      const filtered = exclusion(item, this.store.data.preferences)
      if (filtered) {
        item.status = 'skipped'; item.skipSource = 'filter'; item.reason = filtered; await this.store.save()
        results.push({ key: item.key, status: item.status, reason: filtered }); continue
      }
      if ((item.preferenceRevision ?? 0) !== (this.store.data.preferenceRevision ?? 0)) {
        item.status = 'draft'; item.reason = '设置版本已变化，草稿需重新生成或确认。'; await this.store.save()
        results.push({ key: item.key, status: item.status, reason: item.reason }); continue
      }
      const pause = Math.max(0, this.store.data.lastAttemptAt + settings.minIntervalMs - Date.now())
      if (pause) await delay(pause, undefined, { signal })
      try {
        const config = preferences(this.store.data.preferences)
        validateReply(item.reply ?? '', config, settings)
        const submit = await this.browser.prepare(settings, adapter, item, signal)
        signal?.throwIfAborted()
        item.status = 'sending'
        item.attemptId = randomUUID()
        item.attemptAt = Date.now()
        this.store.data.lastAttemptAt = item.attemptAt
        await this.store.save() // A crash after this point is always uncertain, never retryable.
        await submit()
        let evidence = null
        for (let poll = 0; poll < 4; poll++) {
          signal?.throwIfAborted()
          const verified = await this.browser.verify(settings, adapter, item)
          if (verified.found) { evidence = verified.evidence; break }
          if (poll < 3) await delay(750, undefined, { signal })
        }
        item.status = evidence ? 'sent' : 'uncertain'
        item.evidence = evidence
        item.reason = evidence ? null : '发送后未读到账号自己的匹配回复。请展开该评论的回复后核实；不会自动重发。'
        if (evidence) item.sentAt = Date.now()
        await this.store.save()
        results.push({ key: item.key, video: item.video, status: item.status, evidence, reason: item.reason })
        if (item.status === 'uncertain') break
      } catch (error) {
        if (item.status === 'sending') {
          item.status = 'uncertain'
          item.reason = error.message
          await this.store.save()
        }
        results.push({ key: item.key, video: item.video, status: item.status, error: error.message })
        // Stop the batch on an ambiguous send, account mismatch, or changed page.
        break
      }
    }
    return { results, remainingReady: Object.values(this.store.data.comments).filter(item => item.status === 'ready' && settings.videos.includes(item.video)).length }
  }

  async reconcile(key) {
    const item = this.store.data.comments[key]
    if (!item || item.status !== 'uncertain') throw new Error('只能核实 uncertain 状态的评论。')
    this.allowedVideo(item.video)
    const result = await this.browser.verify(this.settings(), this.adapter(), item)
    if (result.found) { item.status = 'sent'; item.evidence = result.evidence; item.reason = null; item.sentAt = Date.now(); await this.store.save() }
    return { key, status: item.status, evidence: result.evidence, note: result.found ? '已在页面核实。' : '仍未找到；未找到不等于未发送，继续保留 uncertain，禁止自动重发。' }
  }

  async skip(key, reason) {
    const item = this.store.data.comments[key]
    if (!item || !['new', 'draft', 'ready'].includes(item.status)) throw new Error('只能跳过尚未发送的评论。')
    item.status = 'skipped'; item.skipSource = 'manual'; item.reason = normalized(reason) || '按任务规则跳过'
    await this.store.save()
    return { key, status: item.status }
  }

  status() {
    const counts = {}
    const comments = Object.values(this.store.data.comments)
    for (const item of comments) counts[item.status] = (counts[item.status] ?? 0) + 1
    return { settings: this.store.data.settings, replyPreferences: preferences(this.store.data.preferences), preferenceRevision: this.store.data.preferenceRevision ?? 0, calibrated: !!this.store.data.adapter, counts, comments: comments.map(({ key, video, author, text, reply, status, reason }) => ({ key, video, author, text, reply, status, reason })) }
  }

  async close() { this.stopping = true; await this.browser.cancelPage(); await this.tail; await this.browser.close(); await this.store.close() }
}
