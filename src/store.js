import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export class Store {
  constructor(directory) { this.directory = resolve(directory); this.lock = null; this.data = null }

  async init() {
    await mkdir(this.directory, { recursive: true })
    const lockPath = join(this.directory, 'process.lock')
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.lock = await open(lockPath, 'wx')
        await this.lock.writeFile(JSON.stringify({ pid: process.pid }))
        await this.lock.sync()
        break
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        let pid
        try { pid = JSON.parse(await readFile(lockPath, 'utf8')).pid } catch { throw new Error('状态目录锁无法识别，请确认没有其他实例后处理 process.lock。') }
        if (!Number.isInteger(pid) || pid <= 0) throw new Error('状态目录锁无效。')
        try { process.kill(pid, 0); throw new Error('该状态目录已有运行中的插件实例。') }
        catch (probe) { if (probe.code !== 'ESRCH') throw probe }
        await unlink(lockPath)
      }
    }
    if (!this.lock) throw new Error('无法锁定状态目录。')
    try {
      try { this.data = JSON.parse(await readFile(join(this.directory, 'state.json'), 'utf8')) }
      catch (error) { if (error.code !== 'ENOENT') throw error; this.data = { version: 1, settings: null, adapter: null, comments: {}, lastAttemptAt: 0 } }
      if (this.data.version !== 1 || !this.data.comments || typeof this.data.comments !== 'object') throw new Error('状态文件不兼容或已损坏。')
      let recovered = false
      for (const item of Object.values(this.data.comments)) {
        if (item.status === 'sending') { item.status = 'uncertain'; item.reason = '上次进程在发送阶段中断；必须核实，不能直接重发。'; recovered = true }
      }
      if (recovered) await this.save()
    } catch (error) { await this.close(); throw error }
    return this
  }

  async save() {
    const target = join(this.directory, 'state.json')
    const temp = `${target}.${randomUUID()}.tmp`
    const file = await open(temp, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(this.data, null, 2)); await file.sync() } finally { await file.close() }
    await rename(temp, target)
  }

  async close() {
    if (!this.lock) return
    await this.lock.close()
    this.lock = null
    await unlink(join(this.directory, 'process.lock'))
  }
}
