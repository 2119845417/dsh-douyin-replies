import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { Browser } from '../src/browser.js'
import { Service } from '../src/service.js'

export const owner = 'https://www.douyin.com/user/test-owner'
export const videos = ['https://www.douyin.com/video/111', 'https://www.douyin.com/video/222']
export const adapter = {
  accountLink: '#account', videoAuthorLink: '#video-author', commentList: '#comments',
  commentRoot: '.comment', nestedReply: '.nested', commentText: '.body', commentAuthor: '.author',
  replyButton: '.reply-button', composer: '.composer', submitButton: '.submit',
  ownReply: '.own-reply', ownReplyAuthorLink: '.reply-author', ownReplyText: '.reply-text',
  challenge: '#challenge', composerScope: 'comment', commentIdAttribute: 'data-comment-id',
}

export function fixture({ account = owner, author = owner, noResult = false, pageComposer = false, duplicates = false, wrongReplyAuthor = false } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>article{padding:10px;border:1px solid #ccc}#comments{height:650px;overflow:auto}.nested{margin-left:20px}textarea{display:block}</style></head><body>
  <a id="account" href="${account}">本人</a><a id="video-author" href="${author}">视频作者</a><div id="challenge" style="display:none">请验证</div>
  <div id="comments"><article class="comment" data-comment-id="c1"><a class="author" href="https://www.douyin.com/user/a">甲</a><p class="body">第一条顶层评论</p><button class="reply-button">回复</button>
    <div class="nested"><article class="comment" data-comment-id="nested"><a class="author" href="https://www.douyin.com/user/b">乙</a><p class="body">不能回复这条楼中楼</p><button class="reply-button">回复</button></article></div>
  </article>
  <article class="comment" data-comment-id="c2"><a class="author" href="https://www.douyin.com/user/c">丙</a><p class="body">第二条顶层评论</p><button class="reply-button">回复</button></article>
  ${duplicates ? '<article class="comment"><a class="author">同名</a><p class="body">重复</p><button class="reply-button">回复</button></article>'.repeat(2) : ''}
  </div><div id="global"></div><script>
  document.querySelectorAll('.reply-button').forEach(button => button.addEventListener('click', () => {
    const root = button.closest('.comment');
    const scope = ${pageComposer} ? document.querySelector('#global') : root;
    scope.querySelectorAll('.editor').forEach(el => el.remove());
    const editor = document.createElement('div'); editor.className = 'editor';
    editor.innerHTML = '<span id="reply-target">回复 ' + root.querySelector('.author').innerText + '</span><textarea class="composer"></textarea><button class="submit">发送</button>';
    scope.append(editor);
    editor.querySelector('.submit').addEventListener('click', () => {
      window.sent = (window.sent || 0) + 1;
      if (${noResult}) return;
      const row = document.createElement('div'); row.className = 'own-reply nested';
      const a = document.createElement('a'); a.className='reply-author'; a.href=${JSON.stringify(wrongReplyAuthor ? 'https://www.douyin.com/user/stranger' : owner)}; a.innerText='回复作者';
      const p = document.createElement('p'); p.className='reply-text'; p.innerText=editor.querySelector('textarea').value;
      row.append(a,p); root.append(row); editor.remove();
    });
  }));
  </script></body></html>`
}

export async function makeService(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'douyin-test-'))
  const store = await new Store(directory).init()
  const browser = new Browser(directory)
  const service = new Service(store, browser)
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }) })
  await service.setup({ ownerProfileUrl: owner, videos, minIntervalMs: 1000 })
  await browser.start(service.settings(), { headless: true })
  // All page traffic is intercepted; these tests never contact Douyin.
  await browser.context.route('**/*', route => route.request().resourceType() === 'document'
    ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture(options) }) : route.abort())
  await service.open()
  await service.calibrate(options.pageComposer ? { ...adapter, composerScope: 'page', replyTarget: '#reply-target' } : adapter)
  return service
}
