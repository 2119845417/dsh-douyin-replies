import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { videoUrl, profileUrl, replyTargetMatches, validateSettings } from '../src/domain.js'

test('persistent journal recovers interrupted sends as uncertain', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'douyin-store-'))
  let store = await new Store(directory).init()
  try {
    store.data.comments.a = { key: 'a', status: 'sending', reply: '已准备发送' }
    await store.save(); await store.close()
    store = await new Store(directory).init()
    assert.equal(store.data.comments.a.status, 'uncertain')
    assert.match(store.data.comments.a.reason, /不能直接重发/u)
    await assert.rejects(() => new Store(directory).init(), /运行中的/u)
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }) }
})

test('corrupt state is never silently replaced with an empty dedup ledger', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'douyin-corrupt-'))
  try {
    await writeFile(join(directory, 'state.json'), '{broken')
    await assert.rejects(() => new Store(directory).init(), SyntaxError)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('URLs restrict browser workflow to explicit Douyin videos and accounts', () => {
  assert.equal(videoUrl('https://douyin.com/video/123?share=1'), 'https://www.douyin.com/video/123')
  for (const url of ['https://douyin.com.evil.test/video/1', 'https://u:p@www.douyin.com/video/1', 'http://www.douyin.com/video/1', 'https://v.douyin.com/x', 'https://www.douyin.com:4430/video/1']) assert.throws(() => videoUrl(url))
  assert.equal(profileUrl('https://www.douyin.com/user/abc?foo=1'), 'https://www.douyin.com/user/abc')
  assert.throws(() => validateSettings({ ownerProfileUrl: 'https://www.douyin.com/user/a', videos: ['https://www.douyin.com/video/1'], minIntervalMs: 0 }))
})

test('page composer target must match the entire username', () => {
  assert.equal(replyTargetMatches('回复 @甲：', '甲'), true)
  assert.equal(replyTargetMatches('回复 @甲乙：', '甲'), false)
  assert.equal(replyTargetMatches('回复 丙', '丙'), true)
})
