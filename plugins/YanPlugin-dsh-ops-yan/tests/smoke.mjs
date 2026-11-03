#!/usr/bin/env node
/**
 * Zero-dependency smoke test for the packaged MCP server.
 *
 * Runs the real `server.cjs` over stdio in a throw-away workspace and checks
 * the protocol surface plus the behaviours this port promises:
 * path confinement, encoding gates, paging fields and error flags.
 *
 * Usage: node tests/smoke.mjs
 * Exit code 0 only when every check passes.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const server = path.join(root, 'server.cjs')
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ops-smoke-ws-'))
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ops-smoke-out-'))

const results = []
function check(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error: error.message })
  }
}
function equal(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${label || 'value'}: expected ${e}, got ${a}`)
}
function ok(value, label) {
  if (!value) throw new Error(label || 'expected truthy')
}
function includes(text, needle, label) {
  if (!String(text).includes(needle)) throw new Error(`${label || 'text'}: missing "${needle}" in ${String(text).slice(0, 200)}`)
}

function start(workspaceRoot) {
  const child = spawn(process.execPath, [server], {
    env: { ...process.env, OPS_WORKSPACE: workspaceRoot },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let buffer = ''
  let nextId = 0
  const pending = new Map()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      const settle = pending.get(message.id)
      if (!settle) continue
      pending.delete(message.id)
      settle(message)
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => process.stderr.write(chunk))

  function request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`timeout waiting for ${method}`))
      }, 20000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        if (message.error) reject(new Error(`${method} failed: ${message.error.message}`))
        else resolve(message.result)
      })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  async function call(name, args) {
    const result = await request('tools/call', { name, arguments: args })
    const text = result?.content?.[0]?.text ?? ''
    let parsed
    try { parsed = JSON.parse(text) } catch { parsed = null }
    return { failed: Boolean(result?.isError), text, body: parsed }
  }

  return {
    request,
    call,
    initialize: () => request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } }),
    close: () => child.kill()
  }
}

function payload(text) {
  fs.writeFileSync(path.join(workspace, 'note.md'), text)
}
payload('alpha\nbeta\ngamma\n')
fs.writeFileSync(path.join(workspace, 'data.csv'), 'name,score\nzhang,91\nli,84\nwang,77\n')
fs.mkdirSync(path.join(workspace, 'sub'), { recursive: true })
fs.writeFileSync(path.join(workspace, 'sub', 'a.txt'), 'one\ntwo\n')
fs.writeFileSync(path.join(workspace, 'sub', 'b.txt'), 'three\nfour\n')
fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret\n')

const client = start(workspace)
const emptyClient = start('')

try {
  const init = await client.initialize()
  check('initialize returns dsh-ops', () => {
    equal(init.serverInfo.name, 'dsh-ops', 'serverInfo.name')
    ok(/^\d+\.\d+\.\d+$/.test(init.serverInfo.version), 'serverInfo.version')
  })

  const tools = await client.request('tools/list')
  check('tools/list exposes the 9 read-only tools', () => {
    equal(tools.tools.map((tool) => tool.name).sort(), [
      'diff', 'glob', 'grep', 'inspect_local_file', 'read_docx',
      'read_files', 'read_pdf', 'read_table', 'stat'
    ])
    for (const tool of tools.tools) equal(tool.inputSchema.type, 'object', `${tool.name}.inputSchema.type`)
  })

  const stat = await client.call('stat', { path: 'note.md' })
  check('stat reports exact file facts', () => {
    ok(!stat.failed, stat.text)
    equal(stat.body.status, 'completed', 'status')
    equal(stat.body.bytes, 17, 'bytes')
    equal(stat.body.lineCount, 3, 'lineCount')
  })

  const statAbsolute = await client.call('stat', { path: path.join(workspace, 'note.md') })
  check('stat accepts absolute paths inside the workspace', () => {
    ok(!statAbsolute.failed, statAbsolute.text)
    equal(statAbsolute.body.exists, true, 'exists')
  })

  const escape = await client.call('stat', { path: path.join('..', path.basename(outside), 'secret.txt') })
  check('stat rejects paths outside the workspace', () => {
    ok(escape.failed, 'expected isError')
    includes(escape.text, 'outside the workspace')
  })

  const readFiles = await client.call('read_files', { files: [{ path: 'sub/a.txt', limit: 2 }, { path: 'sub/b.txt', limit: 2 }] })
  check('read_files reads several files in one call', () => {
    ok(!readFiles.failed, readFiles.text)
    equal(readFiles.body.items.length, 2, 'file count')
    equal(readFiles.body.items[0].items[0].text, 'one', 'first line')
  })

  const table = await client.call('read_table', { path: 'data.csv', limit: 2 })
  check('read_table returns columns and a next offset', () => {
    ok(!table.failed, table.text)
    equal(table.body.columns, ['name', 'score'])
    equal(table.body.items.length, 2)
    equal(table.body.nextOffset, 3)
  })

  const badTableEncoding = await client.call('read_table', { path: 'data.csv', encoding: 'gb18030' })
  check('read_table rejects unsupported encodings before spawning the worker', () => {
    ok(badTableEncoding.failed, 'expected isError')
    includes(badTableEncoding.text, 'utf-16be')
  })

  const badInspectEncoding = await client.call('inspect_local_file', { path: 'note.md', encoding: 'latin1' })
  check('inspect_local_file rejects non UTF-8 encodings', () => {
    ok(badInspectEncoding.failed, 'expected isError')
    includes(badInspectEncoding.text, 'UTF-8')
  })

  const unknownField = await client.call('stat', { path: 'note.md', bogus: true })
  check('worker rejects unknown arguments', () => {
    ok(unknownField.failed, 'expected isError')
    equal(unknownField.body.error.code, 'INVALID_ARGUMENT')
  })

  const noWorkspace = await emptyClient.call('stat', { path: 'note.md' })
  check('tools fail cleanly without OPS_WORKSPACE', () => {
    ok(noWorkspace.failed, 'expected isError')
    includes(noWorkspace.text, 'OPS_WORKSPACE')
  })

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'yan-plugin.json'), 'utf8'))
  check('manifest keeps the host contract', () => {
    equal(manifest.schemaVersion, 1, 'schemaVersion')
    equal(manifest.mcpServers[0].timeoutMs, 60000, 'timeoutMs')
    equal(manifest.mcpServers[0].env.OPS_TIMEOUT_MS, '55000', 'OPS_TIMEOUT_MS')
    ok(manifest.platforms.includes('win32'), 'platforms')
  })
  const readFilesSchema = tools.tools.find((tool) => tool.name === 'read_files').inputSchema
  check('schema encodes the file-count limit', () => {
    equal(readFilesSchema.properties.files.maxItems, 32, 'maxItems')
  })
  const pdfSchema = tools.tools.find((tool) => tool.name === 'read_pdf').inputSchema
  check('schema encodes the PDF page limit', () => {
    equal(pdfSchema.properties.limit.maximum, 32, 'limit.maximum')
  })
} catch (error) {
  results.push({ name: 'unexpected failure', ok: false, error: error.message })
} finally {
  client.close()
  emptyClient.close()
  fs.rmSync(workspace, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
}

const failed = results.filter((item) => !item.ok)
for (const item of results) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.ok ? '' : `\n      ${item.error}`}`)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
