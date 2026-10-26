#!/usr/bin/env node
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { Store } from './store.js'
import { Browser } from './browser.js'
import { Service } from './service.js'

const directory = resolve(process.env.DSH_DOUYIN_HOME || join(homedir(), '.dsh', 'douyin-replies'))
const store = await new Store(directory).init()
const service = new Service(store, new Browser(store.directory))
const [command, filename] = process.argv.slice(2)
try {
  const input = filename ? JSON.parse(await readFile(filename, 'utf8')) : {}
  let result
  if (command === 'setup') result = await service.setup(input)
  else if (command === 'status') result = service.status()
  else if (command === 'browser') {
    result = await service.open(input)
    console.log(JSON.stringify(result, null, 2))
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    await rl.question('可在窗口扫码登录或检查页面。完成后按 Enter 关闭并保存登录目录：')
    rl.close()
    result = { closed: true }
  } else if (command === 'scan') result = await service.scan(input)
  else throw new Error('用法：node src/cli.js setup <配置.json> | browser [参数.json] | status | scan [参数.json]。完整校准和发送通过 Harness 工具执行。')
  console.log(JSON.stringify(result, null, 2))
} catch (error) { console.error(error.message); process.exitCode = 1 }
finally { await service.close() }
