import { createHash } from 'node:crypto'

export const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 24)
export const normalized = text => String(text ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim()
export const replyTargetMatches = (text, author) => normalized(text).replace(/^回复\s*[@＠]?\s*/u, '').replace(/[：:]$/u, '').trim() === normalized(author)

export function videoUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || !['www.douyin.com', 'douyin.com'].includes(url.hostname) || url.port || url.username || url.password) {
    throw new Error('仅接受 https://www.douyin.com/video/<数字ID> 完整视频链接。')
  }
  const match = /^\/video\/(\d+)\/?$/u.exec(url.pathname)
  if (!match) throw new Error('请先将分享短链接打开为 /video/<数字ID> 完整链接。')
  return `https://www.douyin.com/video/${match[1]}`
}

export function profileUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || !['www.douyin.com', 'douyin.com'].includes(url.hostname) || url.port || url.username || url.password || !/^\/user\/[\w-]+\/?$/u.test(url.pathname)) {
    throw new Error('账号必须是 https://www.douyin.com/user/<账号ID> 完整链接。')
  }
  return `https://www.douyin.com${url.pathname.replace(/\/$/u, '')}`
}

export function commentKey(video, comment) {
  return hash(`${video}\n${comment.domId ? `id:${comment.domId}` : `body:${comment.author}\n${comment.text}`}`)
}

export function validateSettings(input) {
  const ownerProfileUrl = profileUrl(input.ownerProfileUrl)
  if (!Array.isArray(input.videos) || !input.videos.length || input.videos.length > 100) throw new Error('videos 需要 1–100 个视频链接。')
  const videos = [...new Set(input.videos.map(videoUrl))]
  const maxRepliesPerRun = input.maxRepliesPerRun ?? 10
  const minIntervalMs = input.minIntervalMs ?? 15000
  const maxReplyLength = input.maxReplyLength ?? 300
  if (!Number.isInteger(maxRepliesPerRun) || maxRepliesPerRun < 1 || maxRepliesPerRun > 100) throw new Error('maxRepliesPerRun 范围为 1–100。')
  if (!Number.isInteger(minIntervalMs) || minIntervalMs < 1000) throw new Error('minIntervalMs 至少 1000。')
  if (!Number.isInteger(maxReplyLength) || maxReplyLength < 1 || maxReplyLength > 2000) throw new Error('maxReplyLength 范围为 1–2000。')
  const channel = input.channel ?? 'chrome'
  if (!['chrome', 'msedge', 'chromium'].includes(channel)) throw new Error('channel 只能为 chrome、msedge 或 chromium。')
  return { ownerProfileUrl, videos, maxRepliesPerRun, minIntervalMs, maxReplyLength, channel }
}

export function validateAdapter(adapter) {
  const required = ['accountLink', 'videoAuthorLink', 'commentList', 'commentRoot', 'nestedReply', 'commentText', 'commentAuthor', 'replyButton', 'composer', 'submitButton', 'ownReply', 'ownReplyAuthorLink', 'ownReplyText', 'challenge']
  const result = {}
  for (const key of required) {
    if (typeof adapter[key] !== 'string' || !adapter[key].trim() || adapter[key].length > 1500) throw new Error(`缺少 CSS 选择器：${key}`)
    result[key] = adapter[key].trim()
  }
  const attribute = adapter.commentIdAttribute ?? 'data-comment-id'
  if (!/^[a-z][a-z0-9_-]*$/u.test(attribute)) throw new Error('commentIdAttribute 必须是 HTML 属性名。')
  result.commentIdAttribute = attribute
  result.composerScope = adapter.composerScope ?? 'comment'
  for (const key of ['openComments', 'expandReplies']) {
    if (adapter[key] !== undefined) {
      if (typeof adapter[key] !== 'string' || !adapter[key].trim() || adapter[key].length > 1500) throw new Error(`${key} 必须是 CSS 选择器。`)
      result[key] = adapter[key].trim()
    }
  }
  if (!['comment', 'page'].includes(result.composerScope)) throw new Error('composerScope 只能为 comment 或 page。')
  if (result.composerScope === 'page') {
    if (typeof adapter.replyTarget !== 'string' || !adapter.replyTarget.trim()) throw new Error('页面级输入框必须配置 replyTarget，显示正在回复的用户。')
    result.replyTarget = adapter.replyTarget.trim()
  }
  return result
}
