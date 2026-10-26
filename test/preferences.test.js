import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { preferences, updatePreferences, exclusion, validateReply } from '../src/preferences.js'
import { Service } from '../src/service.js'
import { Store } from '../src/store.js'
import { makeService, owner, videos } from './helpers.js'

test('partial preference updates retain persona fields, replace arrays, and reject invalid data', () => {
  const first = updatePreferences(null, { persona: { name: '小林', tone: '温柔幽默', examples: ['谢谢你来！'] }, filters: { keywords: ['互关', '互关'], categories: ['人身攻击'] } })
  const next = updatePreferences(first, { persona: { maxLength: 80 }, filters: { keywords: [] } })
  assert.equal(next.persona.name, '小林')
  assert.equal(next.persona.tone, '温柔幽默')
  assert.deepEqual(next.persona.examples, ['谢谢你来！'])
  assert.deepEqual(next.filters.keywords, [])
  assert.deepEqual(next.filters.categories, ['人身攻击'])
  assert.equal(first.persona.maxLength, 120, 'updating a copy does not mutate previous configuration')
  for (const patch of [{ persona: { maxLength: 0 } }, { filters: { skipLinks: 'yes' } }, { filters: { keywords: [null] } }, { filters: { regex: '.*' } }, { persona: null }]) assert.throws(() => updatePreferences(first, patch))
})

test('keyword and author exclusions use normalized text and exact identities', () => {
  const config = updatePreferences(null, { filters: { keywords: ['Promo'], authors: ['不回复的人', 'https://www.douyin.com/user/blocked'], skipLinks: true } })
  assert.match(exclusion({ text: '这里是 PROMO', author: '甲' }, config), /关键词/u)
  assert.match(exclusion({ text: '普通话题', author: '不回复的人' }, config), /作者/u)
  assert.match(exclusion({ text: '普通话题', author: '同名无关', authorUrl: 'https://www.douyin.com/user/blocked?from=comment' }, config), /作者/u)
  assert.match(exclusion({ text: '看 https://example.com', author: '甲' }, config), /链接/u)
  assert.equal(exclusion({ text: '普通评论', author: '不回复的人乙', authorUrl: 'https://www.douyin.com/user/other' }, config), null)
})

test('pure emoji filtering does not discard numeric text or ordinary words', () => {
  const config = updatePreferences(null, { filters: { skipEmojiOnly: true } })
  for (const text of ['😊 ❤️', '👍🏽', '👨‍👩‍👧‍👦', '🇨🇳', '1️⃣']) assert.match(exclusion({ text }, config), /纯文字表情/u)
  for (const text of ['123😊', '喜欢😊', '123', '']) assert.equal(exclusion({ text }, config), null)
})

test('reply text obeys persona/task length and forbidden phrases', () => {
  const config = updatePreferences(null, { persona: { maxLength: 10 }, filters: { forbiddenReplyKeywords: ['保证有效'] } })
  assert.equal(validateReply('谢谢  你', config, { maxReplyLength: 30 }), '谢谢 你')
  assert.throws(() => validateReply('保证有效', config, { maxReplyLength: 30 }), /禁用/u)
  assert.throws(() => validateReply('12345678901', config, { maxReplyLength: 30 }), /长度/u)
  assert.throws(() => validateReply('12345', config, { maxReplyLength: 4 }), /长度/u)
  assert.throws(() => validateReply('', config, { maxReplyLength: 30 }), /不能为空/u)
})

test('preferences persist across restarts; rule removal restores filtered comments only', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'douyin-preferences-'))
  const browser = { cancelPage: async () => {}, close: async () => {} }
  let store = await new Store(directory).init()
  let service = new Service(store, browser)
  t.after(async () => {
    await service.close()
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep) || !directory.includes('douyin-preferences-')) throw new Error('Unexpected test cleanup directory')
    await rm(directory, { recursive: true, force: true })
  })
  await service.setup({ ownerProfileUrl: owner, videos })
  store.data.comments.a = { key: 'a', text: '互关吧', author: '甲', status: 'new', video: videos[0] }
  store.data.comments.b = { key: 'b', text: '互关吧', author: '乙', status: 'skipped', skipSource: 'manual', reason: '人工决定不回复', video: videos[0] }
  await service.setPreferences({ persona: { name: '阿青', instructions: '用一句话自然回复' }, filters: { keywords: ['互关'], categories: ['引流广告'] } })
  assert.equal(store.data.comments.a.status, 'skipped')
  await service.close()
  store = await new Store(directory).init()
  service = new Service(store, browser)
  assert.equal(service.replyContext().preferences.persona.name, '阿青')
  assert.deepEqual(service.replyContext().preferences.filters.categories, ['引流广告'])
  assert.equal(store.data.comments.a.status, 'skipped')
  await service.setPreferences({ filters: { keywords: [] } })
  assert.equal(store.data.comments.a.status, 'new')
  assert.equal(store.data.comments.b.status, 'skipped')
  assert.equal(store.data.comments.b.reason, '人工决定不回复')
  assert.equal(service.replyContext().preferences.persona.name, '阿青')
})

test('scanning applies filters before drafting; configured persona context version is required', async t => {
  const service = await makeService(t)
  await service.setPreferences({ persona: { name: '小溪', tone: '平和、简短' }, filters: { keywords: ['第一条'], categories: ['广告引流'] } })
  const scan = await service.scan({ video: videos[0] })
  assert.equal(scan.videos[0].comments[0].status, 'skipped')
  assert.equal(scan.videos[0].comments[1].status, 'new')
  const blocked = scan.videos[0].comments[0].key
  const eligible = scan.videos[0].comments[1].key
  const context = service.replyContext(eligible)
  assert.equal(context.preferences.persona.name, '小溪')
  assert.deepEqual(context.preferences.filters.categories, ['广告引流'])
  await assert.rejects(() => service.draft(blocked, '不能绕过', true, context.revision), /skipped/u)
  await assert.rejects(() => service.draft(eligible, '谢谢你的留言！', true), /revision/u)
  await service.draft(eligible, '谢谢你的留言！', true, context.revision)
  const result = await service.send({ keys: [eligible] })
  assert.equal(result.results[0].status, 'sent')
})

test('persona edits demote ready replies; stale revision cannot publish', async t => {
  const service = await makeService(t)
  const scan = await service.scan({ video: videos[0] })
  const key = scan.videos[0].comments[0].key
  await service.draft(key, '旧设置的回复', true)
  await service.setPreferences({ persona: { tone: '严谨、克制' } })
  assert.equal(service.store.data.comments[key].status, 'draft')
  assert.equal((await service.send()).results.length, 0)
  assert.equal(await service.browser.page.evaluate(() => window.sent || 0), 0)
  await assert.rejects(() => service.draft(key, '不能沿用旧版本', true, 0), /revision/u)
  const revision = service.replyContext(key).revision
  await service.draft(key, '感谢留言。', true, revision)
  assert.equal((await service.send()).results[0].status, 'sent')
})

test('new exclusions immediately remove queued replies and prohibited phrasing blocks draft', async t => {
  const service = await makeService(t)
  const scan = await service.scan({ video: videos[0] })
  const [first, second] = scan.videos[0].comments
  await service.draft(first.key, '原本准备回复', true)
  await service.setPreferences({ filters: { keywords: ['第一条'], forbiddenReplyKeywords: ['百分之百'] } })
  assert.equal(service.store.data.comments[first.key].status, 'skipped')
  const revision = service.replyContext(second.key).revision
  await assert.rejects(() => service.draft(second.key, '百分之百没问题', true, revision), /禁用/u)
  assert.equal((await service.send()).results.length, 0)
  assert.equal(await service.browser.page.evaluate(() => window.sent || 0), 0)
})

test('applying identical preferences leaves ready replies valid', async t => {
  const service = await makeService(t)
  await service.setPreferences({ persona: { tone: '温暖、简短' } })
  const scan = await service.scan({ video: videos[0] })
  const key = scan.videos[0].comments[0].key
  const revision = service.replyContext(key).revision
  await service.draft(key, '谢谢喜欢！', true, revision)
  const result = await service.setPreferences({ persona: { tone: '温暖、简短' } })
  assert.equal(result.revision, revision)
  assert.equal(service.store.data.comments[key].status, 'ready')
  assert.deepEqual(result.affected, [])
})

test('semantic categories are retained as model instructions rather than guessed keyword rules', () => {
  const config = updatePreferences(null, { filters: { categories: ['人身攻击'] } })
  assert.deepEqual(preferences(config).filters.categories, ['人身攻击'])
  assert.equal(exclusion({ text: '我在讨论如何减少人身攻击' }, config), null)
})
