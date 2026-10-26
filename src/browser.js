import { chromium } from 'playwright-core'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { commentKey, normalized, profileUrl, replyTargetMatches, videoUrl } from './domain.js'

// Runs inside the page. It intentionally reads only currently rendered, visible roots.
export function collectComments(adapter) {
  const visible = el => !!(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
  const norm = text => String(text ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim()
  const lists = [...document.querySelectorAll(adapter.commentList)].filter(visible)
  if (lists.length !== 1) throw new Error('评论列表必须匹配且仅匹配一个可见容器。')
  const roots = [...lists[0].querySelectorAll(adapter.commentRoot)]
  return roots.map((root, index) => {
    if (!visible(root) || root.closest(adapter.nestedReply)) return null
    if (root.parentElement?.closest(adapter.commentRoot)) return null
    const direct = selector => [...root.querySelectorAll(selector)].filter(el => !el.closest(adapter.nestedReply) && el.closest(adapter.commentRoot) === root && visible(el))
    const texts = direct(adapter.commentText)
    const authors = direct(adapter.commentAuthor)
    if (texts.length !== 1 || authors.length !== 1) return null
    const ownReplies = [...root.querySelectorAll(adapter.ownReply)].filter(visible).map(reply => {
      const authorLinks = [...reply.querySelectorAll(adapter.ownReplyAuthorLink)].filter(visible)
      const replyTexts = [...reply.querySelectorAll(adapter.ownReplyText)].filter(visible)
      if (authorLinks.length !== 1 || replyTexts.length !== 1) return null
      return { authorUrl: authorLinks[0].href ?? '', text: norm(replyTexts[0].innerText) }
    }).filter(Boolean)
    return { index, domId: root.getAttribute(adapter.commentIdAttribute) ?? '', author: norm(authors[0].innerText), authorUrl: authors[0].href ?? '', text: norm(texts[0].innerText), ownReplies }
  }).filter(item => item && item.author && item.text)
}

export class Browser {
  constructor(directory) { this.directory = directory; this.context = null; this.page = null; this.channel = null; this.videoPages = new Map() }

  async start(settings, { headless = false } = {}) {
    if (this.context && this.channel !== settings.channel) throw new Error('切换浏览器 channel 前请关闭并重启插件。')
    if (!this.context) {
      await mkdir(join(this.directory, 'browser-profile'), { recursive: true })
      this.context = await chromium.launchPersistentContext(join(this.directory, 'browser-profile'), {
        channel: settings.channel, headless, viewport: { width: 1360, height: 940 },
      })
      this.context.setDefaultTimeout(7000)
      this.channel = settings.channel
    }
    if (!this.page || this.page.isClosed()) this.page = this.context.pages()[0] ?? await this.context.newPage()
    return this.page
  }

  async open(settings, url) {
    const page = await this.navigate(settings, url ?? settings.videos[0])
    await page.bringToFront()
    return { url: page.url(), title: await page.title(), message: '独立浏览器已打开。首次请在此窗口手动扫码登录，再检查页面并校准选择器。' }
  }

  async navigate(settings, video) {
    await this.start(settings)
    let page = this.videoPages.get(video)
    if (!page || page.isClosed()) {
      const currentIsAssigned = [...this.videoPages.values()].includes(this.page)
      page = !currentIsAssigned && this.page && !this.page.isClosed() ? this.page : await this.context.newPage()
      this.videoPages.set(video, page)
    }
    this.page = page
    if (page.url() !== video) await page.goto(video, { waitUntil: 'domcontentloaded', timeout: 30000 })
    return page
  }

  async inspect(selector) {
    const page = this.page
    if (!page || page.isClosed()) throw new Error('先运行 douyin_open_browser。')
    const elements = await page.evaluate(selector => {
      const visible = el => !!(el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
      const targets = [...document.querySelectorAll(selector || 'a,button,input,textarea,[contenteditable="true"],[role="button"],[data-e2e]')].filter(visible)
      return targets.slice(0, 160).map(el => ({
        tag: el.tagName.toLowerCase(), text: (el.innerText ?? '').slice(0, 350),
        attributes: Object.fromEntries([...el.attributes].filter(attr => ['id', 'class', 'href', 'role', 'aria-label', 'placeholder', 'contenteditable'].includes(attr.name) || attr.name.startsWith('data-')).map(attr => [attr.name, attr.value])),
        html: selector ? el.outerHTML.slice(0, 3500) : undefined,
      }))
    }, selector ?? '')
    return { url: page.url(), title: await page.title(), elements: JSON.parse(JSON.stringify(elements)), truncatedAt: 160 }
  }

  async screenshot(path) {
    if (!this.page || this.page.isClosed()) throw new Error('浏览器尚未打开。')
    await this.page.screenshot({ path, fullPage: false })
    return { path }
  }

  async assertIdentity(settings, adapter, video) {
    const page = this.page
    if (!page || page.isClosed()) throw new Error('浏览器页面已关闭。')
    if (videoUrl(page.url()) !== video) throw new Error('当前页面不属于目标视频，停止操作。')
    const visible = async selector => {
      const locator = page.locator(selector)
      const indices = []
      for (let i = 0; i < await locator.count(); i++) if (await locator.nth(i).isVisible()) indices.push(i)
      return indices
    }
    if ((await visible(adapter.challenge)).length) throw new Error('页面出现人工验证或登录提示，请在浏览器中处理后继续。')
    for (const [key, label] of [['accountLink', '登录账号'], ['videoAuthorLink', '视频作者']]) {
      const indices = await visible(adapter[key])
      if (indices.length !== 1) throw new Error(`${label}选择器需要唯一可见链接，请重新校准。`)
      const href = await page.locator(adapter[key]).nth(indices[0]).getAttribute('href')
      if (!href || profileUrl(new URL(href, page.url()).href) !== settings.ownerProfileUrl) throw new Error(`${label}与已配置的个人账号不一致，停止操作。`)
    }
  }

  async scan(settings, adapter, video, { scroll = false } = {}) {
    const page = await this.navigate(settings, video)
    await this.assertIdentity(settings, adapter, video)
    if (!await page.locator(adapter.commentList).filter({ visible: true }).count() && adapter.openComments) {
      const button = page.locator(adapter.openComments).filter({ visible: true })
      const text = await button.count() === 1 ? await button.innerText() : ''
      if (!/评论/u.test(text) || /发送|发布|回复/u.test(text)) throw new Error('展开评论按钮无法可靠识别，请手动打开评论面板。')
      await button.click()
    }
    await page.locator(adapter.commentList).filter({ visible: true }).waitFor({ state: 'visible' })
    if (scroll) {
      await page.locator(adapter.commentList).filter({ visible: true }).evaluate(el => { el.scrollTop += Math.max(el.clientHeight * 0.8, 400) })
      // A bounded settling pause; this never claims all comments have been loaded.
      await page.waitForTimeout(600)
    }
    const comments = await page.evaluate(collectComments, adapter)
    const rows = comments.map(row => ({ ...row, key: commentKey(video, row) }))
    const counts = new Map()
    for (const row of rows) counts.set(row.key, (counts.get(row.key) ?? 0) + 1)
    return { comments: rows.filter(row => counts.get(row.key) === 1), ambiguous: rows.filter(row => counts.get(row.key) > 1).length }
  }

  async find(settings, adapter, item) {
    const scan = await this.scan(settings, adapter, item.video)
    const comment = scan.comments.find(row => row.key === item.key)
    if (!comment) throw new Error('目标顶层评论尚未加载、已删除或无法唯一识别；请展开/滚动后重新扫描。')
    if (comment.author !== item.author || comment.text !== item.text) throw new Error('评论内容或作者发生变化，需重新扫描与生成草稿。')
    const candidate = this.page.locator(adapter.commentList).filter({ visible: true }).locator(adapter.commentRoot).nth(comment.index)
    const observed = await candidate.evaluate((el, { a, token }) => {
      const direct = selector => [...el.querySelectorAll(selector)].filter(child => !child.closest(a.nestedReply) && child.closest(a.commentRoot) === el)
      const texts = direct(a.commentText), authors = direct(a.commentAuthor)
      if (texts.length !== 1 || authors.length !== 1 || el.closest(a.nestedReply)) throw new Error('评论定位在页面更新后失效。')
      const marker = el.getAttribute('data-dsh-douyin-target') || token
      el.setAttribute('data-dsh-douyin-target', marker)
      return { marker, author: authors[0].innerText, text: texts[0].innerText, domId: el.getAttribute(a.commentIdAttribute) || '' }
    }, { a: adapter, token: randomUUID() })
    if (normalized(observed.author) !== item.author || normalized(observed.text) !== item.text || (item.domId && observed.domId !== item.domId)) throw new Error('评论列表发生重排，停止当前操作。')
    // Bind the action to this exact node. A re-render removes the marker and fails closed.
    const root = this.page.locator(`[data-dsh-douyin-target="${observed.marker}"]`)
    return { comment, root }
  }

  async verify(settings, adapter, item) {
    let { comment, root } = await this.find(settings, adapter, item)
    if (adapter.expandReplies) {
      await this.expand(root, adapter)
      ;({ comment } = await this.find(settings, adapter, item))
    }
    const matches = comment.ownReplies.filter(reply => {
      try { return profileUrl(reply.authorUrl) === settings.ownerProfileUrl && normalized(reply.text) === normalized(item.reply) }
      catch { return false }
    })
    return { found: matches.length > 0, evidence: matches.length ? { video: item.video, commentKey: item.key, authorUrl: settings.ownerProfileUrl, reply: item.reply, matchedReplies: matches.length } : null }
  }

  async expand(root, adapter) {
    const buttons = root.locator(adapter.expandReplies).filter({ visible: true })
    if (await buttons.count() !== 1) return
    const text = normalized(await buttons.innerText())
    if (/展开.*回复|查看.*回复|更多回复/u.test(text)) { await buttons.click(); await this.page.waitForTimeout(400) }
  }

  async prepare(settings, adapter, item, signal) {
    signal?.throwIfAborted()
    let { comment, root } = await this.find(settings, adapter, item)
    if (adapter.expandReplies) {
      await this.expand(root, adapter)
      ;({ comment, root } = await this.find(settings, adapter, item))
    }
    if (comment.authorUrl) {
      try { if (profileUrl(comment.authorUrl) === settings.ownerProfileUrl) throw new Error('不回复账号自己发布的评论。') }
      catch (error) { if (error.message.includes('不回复')) throw error }
    }
    const own = comment.ownReplies.some(reply => { try { return profileUrl(reply.authorUrl) === settings.ownerProfileUrl } catch { return false } })
    if (own) throw new Error('该顶层评论已显示账号自己的回复，停止新增回复。')
    const buttons = root.locator(adapter.replyButton)
    const indices = []
    for (let i = 0; i < await buttons.count(); i++) {
      const button = buttons.nth(i)
      if (await button.isVisible() && await button.evaluate((el, a) => !el.closest(a.nestedReply) && el.closest(a.commentRoot) === el.parentElement?.closest(a.commentRoot), adapter)) indices.push(i)
    }
    if (indices.length !== 1) throw new Error('顶层回复按钮不唯一，请校准 replyButton；不会选择楼中楼按钮。')
    signal?.throwIfAborted()
    await buttons.nth(indices[0]).click()
    const scope = adapter.composerScope === 'page' ? this.page : root
    const composer = scope.locator(adapter.composer)
    const submit = scope.locator(adapter.submitButton)
    if (await composer.count() !== 1 || await submit.count() !== 1) throw new Error('回复输入框或发送按钮不唯一。')
    await composer.waitFor({ state: 'visible' })
    if (adapter.composerScope === 'page') {
      const target = this.page.locator(adapter.replyTarget)
      if (await target.count() !== 1 || !replyTargetMatches(await target.innerText(), item.author)) throw new Error('回复输入框未显示正确的目标用户。')
    }
    signal?.throwIfAborted()
    await composer.fill(item.reply)
    if (normalized(await composer.inputValue().catch(() => composer.innerText())) !== normalized(item.reply)) throw new Error('输入内容与草稿不符。')
    await this.assertIdentity(settings, adapter, item.video)
    ;({ comment } = await this.find(settings, adapter, item))
    if (comment.author !== item.author || comment.text !== item.text) throw new Error('发送前评论身份校验失败。')
    if (!await submit.isVisible() || !await submit.isEnabled()) throw new Error('发送按钮不可用。')
    // The caller durably journals "sending" before invoking this closure.
    return async () => {
      signal?.throwIfAborted()
      await this.assertIdentity(settings, adapter, item.video)
      await this.find(settings, adapter, item)
      if (normalized(await composer.inputValue().catch(() => composer.innerText())) !== normalized(item.reply)) throw new Error('发送前输入框内容发生变化。')
      if (adapter.composerScope === 'page') {
        const target = this.page.locator(adapter.replyTarget)
        if (await target.count() !== 1 || !replyTargetMatches(await target.innerText(), item.author)) throw new Error('发送前回复目标发生变化。')
      }
      await submit.click({ timeout: 7000 })
    }
  }

  async cancelPage() { if (this.page && !this.page.isClosed()) await this.page.close().catch(() => {}); this.page = null }
  async close() { if (this.context) await this.context.close(); this.context = null; this.page = null; this.videoPages.clear() }
}
