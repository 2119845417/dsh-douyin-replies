import test from 'node:test'
import assert from 'node:assert/strict'
import { makeService, videos, owner, fixture } from './helpers.js'

test('multi-video scan excludes nested comments and sends only chosen top-level replies', async t => {
  const service = await makeService(t)
  const scanned = await service.scan()
  assert.equal(scanned.videos.length, 2)
  assert.equal(service.browser.videoPages.size, 2)
  for (const result of scanned.videos) {
    assert.equal(result.ok, true)
    assert.equal(result.comments.length, 2)
    assert.ok(result.comments.every(row => !row.text.includes('楼中楼')))
  }
  const first = scanned.videos[0].comments[0]
  const second = scanned.videos[1].comments[0]
  assert.notEqual(first.key, second.key, 'same comment id in different videos has a different key')
  await service.draft(first.key, '谢谢甲的支持！', true)
  await service.draft(second.key, '感谢留言！', true)
  const sent = await service.send()
  assert.deepEqual(sent.results.map(row => row.status), ['sent', 'sent'])
  const repeat = await service.send({ keys: [first.key] })
  assert.equal(repeat.results[0].skipped, true)
  assert.equal(repeat.results[0].status, 'sent')
  assert.equal(service.status().counts.sent, 2)
  const firstPage = service.browser.videoPages.get(videos[0])
  assert.equal(await firstPage.locator('[data-comment-id="c1"] > .own-reply').count(), 1)
})

test('no visible confirmation remains uncertain and cannot be redrafted', async t => {
  const service = await makeService(t, { noResult: true })
  const result = await service.scan({ video: videos[0] })
  const key = result.videos[0].comments[0].key
  await service.draft(key, '测试回复', true)
  const sent = await service.send({ keys: [key] })
  assert.equal(sent.results[0].status, 'uncertain')
  assert.equal(await service.browser.page.evaluate(() => window.sent), 1)
  await assert.rejects(() => service.draft(key, '不能重发', true), /uncertain/u)
  const verified = await service.reconcile(key)
  assert.equal(verified.status, 'uncertain')
  const repeated = await service.send({ keys: [key] })
  assert.equal(repeated.results[0].skipped, true)
  assert.equal(await service.browser.page.evaluate(() => window.sent), 1)
})

test('matching reply text by a different author is not proof of successful publication', async t => {
  const service = await makeService(t, { wrongReplyAuthor: true })
  const result = await service.scan({ video: videos[0] })
  const key = result.videos[0].comments[0].key
  await service.draft(key, '同文不同作者', true)
  assert.equal((await service.send()).results[0].status, 'uncertain')
})

test('page-wide reply composer is checked against target author', async t => {
  const service = await makeService(t, { pageComposer: true })
  const scan = await service.scan({ video: videos[0] })
  const key = scan.videos[0].comments[1].key
  await service.draft(key, '回复丙', true)
  const result = await service.send({ keys: [key] })
  assert.equal(result.results[0].status, 'sent')
  const root = service.browser.page.locator('[data-comment-id="c2"]')
  assert.equal(await root.locator('.own-reply').count(), 1)
  assert.equal(await service.browser.page.locator('[data-comment-id="nested"] .own-reply').count(), 0)
})

test('account mismatch prevents any submit', async t => {
  const service = await makeService(t)
  const scan = await service.scan({ video: videos[0] })
  const key = scan.videos[0].comments[0].key
  await service.draft(key, '不可发送', true)
  await service.browser.page.locator('#account').evaluate(el => el.href = 'https://www.douyin.com/user/other')
  const result = await service.send({ keys: [key] })
  assert.match(result.results[0].error, /登录账号/u)
  assert.equal(await service.browser.page.evaluate(() => window.sent || 0), 0)
  assert.equal(service.store.data.comments[key].status, 'ready')
})

test('identical fallback identities are excluded rather than arbitrarily selected', async t => {
  const service = await makeService(t, { duplicates: true })
  const result = await service.scan({ video: videos[0] })
  assert.equal(result.videos[0].ambiguous, 2)
  assert.equal(result.videos[0].comments.length, 2)
})

test('scan continues to the next video after one video has wrong author', async t => {
  const service = await makeService(t)
  await service.browser.context.unroute('**/*')
  await service.browser.context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture({ author: route.request().url().includes('/222') ? owner : 'https://www.douyin.com/user/other' }) }))
  await service.browser.page.reload()
  const result = await service.scan()
  assert.equal(result.videos[0].ok, false)
  assert.equal(result.videos[1].ok, true)
})

test('comments changed after discovery cannot send an old draft', async t => {
  const service = await makeService(t)
  const scan = await service.scan({ video: videos[0] })
  const key = scan.videos[0].comments[0].key
  await service.draft(key, '旧草稿', true)
  await service.browser.page.locator('[data-comment-id="c1"] > .body').evaluate(el => el.innerText = '已修改正文')
  const result = await service.send({ keys: [key] })
  assert.match(result.results[0].error, /变化/u)
  assert.equal(await service.browser.page.evaluate(() => window.sent || 0), 0)
})

test('cancellation before sending makes no browser mutation', async t => {
  const service = await makeService(t)
  await service.scan({ video: videos[0] })
  const controller = new AbortController(); controller.abort()
  await assert.rejects(() => service.send({}, controller.signal), /abort/iu)
})

test('the selected DOM node stays bound when top-level comments reorder', async t => {
  const service = await makeService(t)
  const scan = await service.scan({ video: videos[0] })
  const key = scan.videos[0].comments[0].key
  await service.draft(key, '仍然只回复甲', true)
  const item = service.store.data.comments[key]
  const submit = await service.browser.prepare(service.settings(), service.adapter(), item)
  await service.browser.page.evaluate(() => {
    const list = document.querySelector('#comments')
    list.prepend(list.querySelector('[data-comment-id="c2"]'))
  })
  await submit()
  assert.equal(await service.browser.page.locator('[data-comment-id="c1"] > .own-reply').count(), 1)
  assert.equal(await service.browser.page.locator('[data-comment-id="c2"] > .own-reply').count(), 0)
})

test('wrong page composer target blocks publication even when username is a substring', async t => {
  const service = await makeService(t, { pageComposer: true })
  const scan = await service.scan({ video: videos[0] })
  const key = scan.videos[0].comments[0].key
  await service.draft(key, '目标必须完全匹配', true)
  const submit = await service.browser.prepare(service.settings(), service.adapter(), service.store.data.comments[key])
  await service.browser.page.locator('#reply-target').evaluate(el => el.innerText = '回复 甲乙')
  await assert.rejects(submit, /目标发生变化/u)
  assert.equal(await service.browser.page.evaluate(() => window.sent || 0), 0)
})

test('an existing reply from the configured account prevents a second publication', async t => {
  const service = await makeService(t)
  const scan = await service.scan({ video: videos[0] })
  const key = scan.videos[0].comments[0].key
  await service.draft(key, '不要再发', true)
  await service.browser.page.locator('[data-comment-id="c1"]').evaluate((root, owner) => {
    const row = document.createElement('div'); row.className = 'own-reply nested'
    const author = document.createElement('a'); author.className = 'reply-author'; author.href = owner; author.innerText = '本人'
    const text = document.createElement('p'); text.className = 'reply-text'; text.innerText = '之前已经回复'
    row.append(author, text); root.append(row)
  }, owner)
  const result = await service.send({ keys: [key] })
  assert.match(result.results[0].error, /已有|已显示/u)
  assert.equal(await service.browser.page.evaluate(() => window.sent || 0), 0)
})
