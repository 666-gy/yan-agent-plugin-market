#!/usr/bin/env node
/**
 * Repeatable correctness + performance benchmark for the packaged MCP server.
 *
 * Each case runs against a throw-away workspace with fixed fixtures, validates
 * the payload shape/content, and reports returned bytes plus p50/p95 latency.
 * Exit code 0 only when every correctness check passes.
 *
 * Usage: node tests/bench.mjs
 */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtures = path.join(root, 'tests', 'fixtures')
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ops-bench-'))
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ops-bench-out-'))

for (const file of fs.readdirSync(fixtures)) fs.copyFileSync(path.join(fixtures, file), path.join(workspace, file))
fs.writeFileSync(path.join(workspace, 'quoted.csv'), 'id,note\n1,"a,b"\n2,"he said ""hi"""\n')
fs.writeFileSync(path.join(workspace, 'table.tsv'), 'id\tname\tvalue\n1\talpha\t10\n2\tbeta\t20\n')
fs.writeFileSync(path.join(workspace, 'binary.bin'), crypto.randomBytes(64 * 1024))
fs.writeFileSync(path.join(workspace, 'readonly.txt'), 'readonly\n')
fs.chmodSync(path.join(workspace, 'readonly.txt'), 0o444)
const bigLines = Array.from({ length: 70000 }, (_, i) => `L${i + 1} 0123456789abcdefghijklmnopqrstuvwxyz`)
fs.writeFileSync(path.join(workspace, 'big.txt'), bigLines.join('\n') + '\n')
const csvLines = ['id,name,score', ...Array.from({ length: 5000 }, (_, i) => `${i + 1},user${i + 1},${((i + 1) * 7) % 100}`)]
fs.writeFileSync(path.join(workspace, 'rows.csv'), csvLines.join('\n') + '\n')
fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret\n')

function start() {
  const child = spawn(process.execPath, [path.join(root, 'server.cjs')], {
    env: { ...process.env, OPS_WORKSPACE: workspace },
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
      const message = JSON.parse(line)
      const settle = pending.get(message.id)
      if (!settle) continue
      pending.delete(message.id)
      settle(message)
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => process.stderr.write(chunk))
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)) }, 60000)
    pending.set(id, (message) => {
      clearTimeout(timer)
      if (message.error) reject(new Error(message.error.message))
      else resolve(message.result)
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  return { request, close: () => child.kill() }
}

const client = start()
const results = []
let failed = 0

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function call(tool, args) {
  const result = await client.request('tools/call', { name: tool, arguments: args })
  const text = result?.content?.[0]?.text ?? ''
  let body
  try { body = JSON.parse(text) } catch { body = null }
  return { failed: Boolean(result?.isError), text, body }
}

async function bench(name, tool, args, { runs = 10, validate } = {}) {
  const times = []
  let bytes = 0
  let sample
  for (let i = 0; i < runs; i++) {
    const started = process.hrtime.bigint()
    const response = await call(tool, args)
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6
    times.push(elapsed)
    bytes = Buffer.byteLength(response.text, 'utf8')
    sample = response
  }
  times.sort((a, b) => a - b)
  const p50 = times[Math.floor(times.length / 2)]
  const p95 = times[Math.min(times.length - 1, Math.ceil(times.length * 0.95) - 1)]
  let ok = true
  let note = ''
  try {
    if (validate) validate(sample, { bytes })
  } catch (error) {
    ok = false
    note = error.message
    failed++
  }
  results.push({ name, tool, bytes, p50: +p50.toFixed(1), p95: +p95.toFixed(1), status: sample.body?.status, ok, note })
  return sample
}

await client.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'bench', version: '0' } })

const bigSize = fs.statSync(path.join(workspace, 'big.txt')).size
const bigSha = crypto.createHash('sha256').update(fs.readFileSync(path.join(workspace, 'big.txt'))).digest('hex')

await bench('stat big.txt', 'stat', { path: 'big.txt' }, {
  validate: (r) => {
    assert(!r.failed, r.text)
    assert(r.body.status === 'completed', `status=${r.body.status}`)
    assert(r.body.bytes === bigSize, `bytes ${r.body.bytes} != ${bigSize}`)
    assert(r.body.lineCount === 70000, `lineCount=${r.body.lineCount}`)
    assert(r.body.revision.length === 64, 'revision is not a 64-hex fingerprint')
  }
})
const statRevision = (await call('stat', { path: 'big.txt' })).body.revision

await bench('read_files 3 ranges', 'read_files', {
  files: [
    { path: 'big.txt', offset: 100, limit: 40 },
    { path: 'big.txt', offset: 20000, limit: 40 },
    { path: 'big.txt', offset: 60000, limit: 40 }
  ]
}, {
  validate: (r) => {
    assert(!r.failed, r.text)
    assert(r.body.items.length === 3, `files=${r.body.items.length}`)
    assert(r.body.items[0].items[0].text === bigLines[99], 'first range line mismatch')
    assert(r.body.items[1].items[0].text === bigLines[19999], 'second range line mismatch')
    assert(r.body.items[2].items[0].text === bigLines[59999], 'third range line mismatch')
  }
})

await bench('read_table 20 rows', 'read_table', { path: 'rows.csv', limit: 20 }, {
  validate: (r) => {
    assert(!r.failed, r.text)
    assert(JSON.stringify(r.body.columns) === JSON.stringify(['id', 'name', 'score']), 'columns mismatch')
    assert(r.body.items.length === 20, `rows=${r.body.items.length}`)
    assert(r.body.nextOffset === 21, `nextOffset=${r.body.nextOffset}`)
    assert(r.body.items[0].cells.join(',') === '1,user1,7', 'first row mismatch')
  }
})

await bench('read_table quoted cells', 'read_table', { path: 'quoted.csv', limit: 5 }, {
  validate: (r) => {
    assert(!r.failed, r.text)
    assert(r.body.items[0].cells[1] === 'a,b', `quoted comma=${r.body.items[0].cells[1]}`)
    assert(r.body.items[1].cells[1] === 'he said "hi"', `escaped quote=${r.body.items[1].cells[1]}`)
  }
})

await bench('read_table tsv', 'read_table', { path: 'table.tsv', format: 'tsv', limit: 5 }, {
  validate: (r) => {
    assert(!r.failed, r.text)
    assert(JSON.stringify(r.body.columns) === JSON.stringify(['id', 'name', 'value']), 'tsv columns mismatch')
  }
})

await bench('grep count', 'grep', { path: '.', pattern: 'user1', outputMode: 'count', glob: ['*.csv'] }, {
  validate: (r) => {
    assert(!r.failed, r.text)
    const csvCount = csvLines.filter((line) => /user1/.test(line)).length
    const entry = r.body.items.find((item) => item.path.endsWith('rows.csv'))
    assert(entry && entry.count === csvCount, `count ${entry?.count} != ${csvCount}`)
  }
})

await bench('grep content', 'grep', { path: 'rows.csv', pattern: 'user42,', limit: 5 }, {
  validate: (r) => {
    assert(!r.failed, r.text)
    assert(r.body.items.length >= 1, 'no matches')
    assert(r.body.items[0].text.includes('user42,'), 'match text missing')
  }
})

await bench('glob details', 'glob', { path: '.', pattern: ['*.csv'], outputMode: 'details' }, {
  validate: (r) => {
    assert(!r.failed, r.text)
    const names = r.body.items.map((item) => (typeof item === 'string' ? item : item.path)).join(' ')
    for (const expected of ['rows.csv', 'quoted.csv', 'gbk.csv']) assert(names.includes(expected), `missing ${expected}`)
  }
})

await bench('read_docx', 'read_docx', { path: 'sample.docx' }, {
  validate: (r) => {
    assert(!r.failed, r.text)
    const texts = r.body.items.map((item) => item.text)
    assert(JSON.stringify(texts) === JSON.stringify(['第一段：dsh-ops 只读验证', '第二段：表格与分页', '第三段：END']), `paragraphs=${JSON.stringify(texts)}`)
  }
})

await bench('read_pdf page 1-2', 'read_pdf', { path: 'sample.pdf' }, {
  validate: (r) => {
    assert(!r.failed, r.text)
    assert(r.body.total === 2, `pages=${r.body.total}`)
    assert(r.body.items[0].text === 'Page one dsh-ops text', `p1=${r.body.items[0].text}`)
    assert(r.body.items[1].text === 'Page two token efficiency', `p2=${r.body.items[1].text}`)
  }
})

await bench('read_pdf paging', 'read_pdf', { path: 'sample.pdf', offset: 2, limit: 1 }, {
  validate: (r) => {
    assert(!r.failed, r.text)
    assert(r.body.items.length === 1 && r.body.items[0].page === 2, 'page paging mismatch')
  }
})

await bench('diff one change', 'diff', { path: 'big.txt', content: `${bigLines.slice(0, 5).join('\n')}\nCHANGED\n` }, {
  validate: (r) => {
    assert(!r.failed, r.text)
    const changed = (r.body.hunk?.added || 0) + (r.body.hunk?.removed || 0)
    assert(changed > 0 || (r.body.items || []).length > 0, 'no changed hunks')
  }
})

await bench('inspect hex', 'inspect_local_file', { path: 'big.txt', view: 'hex', limit: 1 }, {
  validate: (r) => {
    assert(!r.failed, r.text)
    assert(JSON.stringify(r.body).includes('4c 31'), 'hex row missing "4c 31"')
  }
})

await bench('grep skips binary', 'grep', { path: '.', pattern: 'dsh', outputMode: 'summary', glob: ['*.bin'] }, {
  runs: 3,
  validate: (r) => {
    assert(!r.failed, r.text)
    assert((r.body.skippedFiles || 0) >= 1, 'binary file was not reported as skipped')
  }
})

await bench('GBK file rejected', 'read_table', { path: 'gbk.csv' }, {
  runs: 3,
  validate: (r) => {
    assert(r.failed || r.body.status === 'partial', 'GBK file was not flagged')
    assert(r.body.error?.code === 'ERR_INVALID_ENCODING', `code=${r.body.error?.code}`)
  }
})

await bench('outside workspace blocked', 'stat', { path: path.join('..', path.basename(outside), 'secret.txt') }, {
  runs: 3,
  validate: (r) => {
    assert(r.failed, 'escape was allowed')
    assert(r.text.includes('outside the workspace'), r.text)
  }
})

await bench('over-limit rejected', 'read_pdf', { path: 'sample.pdf', limit: 40 }, {
  runs: 3,
  validate: (r) => {
    assert(r.failed, 'over-limit was allowed')
    assert(r.body.error?.code === 'INVALID_ARGUMENT', `code=${r.body.error?.code}`)
  }
})

client.close()
fs.rmSync(workspace, { recursive: true, force: true })
fs.rmSync(outside, { recursive: true, force: true })

const rows = results.map((r) => `| ${r.name} | ${r.bytes} | ${r.p50} | ${r.p95} | ${r.ok ? 'PASS' : `FAIL: ${r.note}`} |`)
console.log('| 用例 | 返回字节 | p50 ms | p95 ms | 正确性 |')
console.log('|---|---|---|---|---|')
console.log(rows.join('\n'))
console.log(`\n${results.length - failed}/${results.length} cases passed`)
console.log(`big.txt=${bigSize} B, revision=${statRevision.slice(0, 12)}…, revisionIsSha256=${statRevision === bigSha}`)
process.exit(failed ? 1 : 0)
