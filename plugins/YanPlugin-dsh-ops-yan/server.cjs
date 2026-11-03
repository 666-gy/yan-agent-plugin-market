'use strict'
/**
 * Minimal MCP stdio server exposing the dsh-ops Rust worker's read-only tools.
 *
 * Transport: newline-delimited JSON-RPC 2.0 (fallback: Content-Length framing).
 * Worker contract: one process per call, one JSON request in, one JSON result out.
 *
 * Environment:
 *   OPS_WORKSPACE  absolute workspace root used for path confinement (Yan: ${workspace})
 *   OPS_WORKER     optional override for the worker executable path
 *   OPS_TIMEOUT_MS per-call worker timeout (default 55000; keep below the plugin timeoutMs)
 *   OPS_OUTPUT_BUDGET_BYTES single-response budget (default 1000000)
 */

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const SERVER_NAME = 'dsh-ops'
const SERVER_VERSION = '0.1.3'

const WORKER = process.env.OPS_WORKER || path.join(
  __dirname, 'bin',
  process.platform === 'win32' ? 'win32-x64' : process.platform === 'darwin' ? 'darwin-arm64' : 'linux-x64',
  process.platform === 'win32' ? 'dsh-ops-worker.exe' : 'dsh-ops-worker'
)

const ROOT = process.env.OPS_WORKSPACE || ''
// This package exposes read-only tools only; the worker always receives read_only: true.
const READ_ONLY = true
const SCOPE = 'yan-dsh-ops'
// Must stay below the host-side timeout (Yan default 30s, this package sets timeoutMs 60000)
// so the worker fails with a structured error instead of the host dropping the connection.
const TIMEOUT_MS = Math.min(Math.max(Number(process.env.OPS_TIMEOUT_MS || 55000), 1000), 119000)
const OUTPUT_BUDGET = Math.max(Number(process.env.OPS_OUTPUT_BUDGET_BYTES || 1000000), 10000)

const str = (description) => ({ type: 'string', description })
const int = (description, minimum = 0, maximum) => ({
  type: 'integer',
  description,
  minimum,
  ...(maximum === undefined ? {} : { maximum })
})
const bool = (description) => ({ type: 'boolean', description })

/** Read-only worker tools: name -> { tool, description, schema } */
const TOOLS = {
  stat: {
    description: 'Exact file/directory facts: size, line count, mtime, revision hash. Cheaper than reading the file.',
    schema: {
      type: 'object',
      properties: { path: str('Absolute or workspace-relative path') },
      required: ['path'],
      additionalProperties: false
    }
  },
  grep: {
    description: 'Bounded regex search inside the workspace. Returns compact line matches or per-file counts instead of whole files.',
    schema: {
      type: 'object',
      properties: {
        path: str('Directory or file to search'),
        pattern: str('Regular expression'),
        glob: { type: 'array', items: { type: 'string' }, description: 'Optional include globs, e.g. ["*.ts"]' },
        outputMode: { type: 'string', enum: ['content', 'files_with_matches', 'count', 'summary'], description: 'Default: content' },
        caseInsensitive: bool('Case-insensitive match'),
        lineNumbers: bool('Include line numbers (default true)'),
        beforeContext: int('Context lines before each match', 0),
        afterContext: int('Context lines after each match', 0),
        multiline: bool('Allow patterns to span lines'),
        offset: int('Match offset for paging', 0),
        limit: int('Maximum matches returned (default 100, max 10000)', 1, 10000),
        exactTotal: bool('Count every match instead of stopping at the page limit (default true)'),
        continuation: str('Continuation token from a previous response')
      },
      required: ['path', 'pattern'],
      additionalProperties: false
    }
  },
  glob: {
    description: 'Bounded path listing by glob pattern. Returns relative paths only.',
    schema: {
      type: 'object',
      properties: {
        path: str('Directory to scan'),
        pattern: { type: 'array', items: { type: 'string' }, description: 'Include globs, e.g. ["**/*.md"]' },
        outputMode: { type: 'string', enum: ['paths', 'details'], description: 'Default: paths' },
        sort: { type: 'string', description: 'Optional sort order accepted by the worker' },
        offset: int('Result offset for paging', 0),
        limit: int('Maximum entries (default 100, max 10000)', 1, 10000),
        continuation: str('Continuation token from a previous response')
      },
      required: ['path', 'pattern'],
      additionalProperties: false
    }
  },
  read_files: {
    description: 'Read 1-32 files in one call with per-file line ranges and line numbers.',
    schema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          minItems: 1,
          maxItems: 32,
          items: {
            type: 'object',
            properties: {
              path: str('Absolute or workspace-relative path'),
              offset: int('First line (1-based, default 1)', 1),
              limit: int('Maximum lines (default 200, max 10000)', 1, 10000)
            },
            required: ['path'],
            additionalProperties: false
          }
        }
      },
      required: ['files'],
      additionalProperties: false
    }
  },
  read_table: {
    description: 'Read a bounded CSV/TSV page with typed column metadata. Never loads the whole file into context.',
    schema: {
      type: 'object',
      properties: {
        path: str('Absolute or workspace-relative path'),
        format: { type: 'string', enum: ['csv', 'tsv'] },
        encoding: { type: 'string', description: 'Default utf-8; supported: utf-8, utf-16le, utf-16be' },
        header: bool('Treat the first row as a header (default true)'),
        offset: int('First data row (1-based, default 1, max 100000)', 1, 100000),
        limit: int('Maximum data rows (default 200, max 1000)', 1, 1000)
      },
      required: ['path'],
      additionalProperties: false
    }
  },
  read_docx: {
    description: 'Extract main-body paragraphs from a DOCX file (no layout, no OCR, no tables rendering).',
    schema: {
      type: 'object',
      properties: {
        path: str('Absolute or workspace-relative path'),
        offset: int('First paragraph (1-based, default 1, max 100000)', 1, 100000),
        limit: int('Maximum paragraphs (default 200, max 1000)', 1, 1000)
      },
      required: ['path'],
      additionalProperties: false
    }
  },
  read_pdf: {
    description: 'Extract the text layer of bounded PDF pages. Scanned pages produce no text (no OCR).',
    schema: {
      type: 'object',
      properties: {
        path: str('Absolute or workspace-relative path'),
        offset: int('First page (1-based, default 1, max 32)', 1, 32),
        limit: int('Maximum pages (default 10, max 32)', 1, 32)
      },
      required: ['path'],
      additionalProperties: false
    }
  },
  diff: {
    description: 'Compare proposed content against the current file and return only changed hunks.',
    schema: {
      type: 'object',
      properties: {
        path: str('Absolute or workspace-relative path'),
        content: str('Proposed full file content'),
        offset: int('Hunk offset for paging', 0),
        limit: int('Maximum hunks (default 100, max 1000)', 1, 1000)
      },
      required: ['path', 'content'],
      additionalProperties: false
    }
  },
  inspect_local_file: {
    description: 'Hex/byte-level inspection of a local file for encoding or corruption questions.',
    schema: {
      type: 'object',
      properties: {
        path: str('Absolute or workspace-relative path'),
        view: { type: 'string', enum: ['text', 'hex'], description: 'Default: text' },
        offset: int('First line (text) or 16-byte row (hex), 1-based', 1),
        limit: int('Maximum lines/rows (1-10000)', 1, 10000),
        encoding: { type: 'string', description: 'Only UTF-8 text is supported (default)' }
      },
      required: ['path'],
      additionalProperties: false
    }
  }
}

const CASE_INSENSITIVE = process.platform === 'win32'
let rootReal

function workspaceReal() {
  if (rootReal === undefined) {
    if (!ROOT) throw new Error('OPS_WORKSPACE is not set; the host must pass the workspace root')
    try {
      rootReal = fs.realpathSync.native(ROOT)
    } catch {
      rootReal = path.resolve(ROOT)
    }
  }
  return rootReal
}

function comparable(value) {
  const normalized = path.normalize(value)
  return CASE_INSENSITIVE ? normalized.toLowerCase() : normalized
}

function inside(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function canonicalPath(target) {
  // Resolve the longest existing prefix, then re-append the missing tail, so a
  // symlinked/junction workspace root and 8.3 short names still compare correctly.
  const segments = []
  let probe = target
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe)
    if (parent === probe) return target
    segments.unshift(path.basename(probe))
    probe = parent
  }
  let base
  try {
    base = fs.realpathSync.native(probe)
  } catch {
    return target
  }
  return segments.length ? path.join(base, ...segments) : base
}

function assertInsideWorkspace(target) {
  const root = comparable(workspaceReal())
  const canonical = canonicalPath(target)
  if (!inside(root, comparable(canonical))) {
    throw new Error(`path is outside the workspace: ${target}`)
  }
  // Hand the canonical path to the worker: it refuses to traverse reparse points,
  // so a workspace root that is itself a junction must be resolved before use.
  return canonical
}

function absolute(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('path must be a non-empty string')
  if (!ROOT) throw new Error('OPS_WORKSPACE is not set; the host must pass the workspace root')
  return assertInsideWorkspace(path.resolve(ROOT, raw))
}

function normalizeEncoding(tool, args) {
  const raw = args.encoding
  if (raw === undefined || raw === '') return
  if (typeof raw !== 'string') throw new Error('encoding must be a string')
  const requested = raw.trim().toLowerCase().replace(/_/g, '-')
  if (tool === 'inspect_local_file') {
    if (requested !== 'utf-8' && requested !== 'utf8') {
      throw new Error('inspect_local_file supports only UTF-8 text (encoding "utf-8")')
    }
    args.encoding = 'utf-8'
    return
  }
  const encoding = requested === 'utf8' ? 'utf-8' : requested
  if (!['utf-8', 'utf-16le', 'utf-16be'].includes(encoding)) {
    throw new Error('read_table supports only utf-8, utf-16le and utf-16be')
  }
  args.encoding = encoding
}

function normalizeArgs(tool, input) {
  const args = { ...(input || {}) }
  normalizeEncoding(tool, args)
  if (tool === 'read_files') {
    const files = args.files
    if (!Array.isArray(files) || files.length === 0) throw new Error('files must be a non-empty array')
    args.files = files.map((entry) => ({ ...entry, path: absolute(entry.path) }))
  } else if (typeof args.path === 'string') {
    args.path = absolute(args.path)
  }
  return args
}

function invoke(tool, args) {
  return new Promise((resolve, reject) => {
    if (!ROOT) return reject(new Error('OPS_WORKSPACE is not set; the host must pass the workspace root'))
    if (!fs.existsSync(WORKER)) return reject(new Error(`worker not found: ${WORKER}`))

    const request = { root: ROOT, scope: SCOPE, read_only: READ_ONLY, tool, args }
    const child = spawn(WORKER, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const stdout = []
    const stderr = []
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`worker timed out after ${TIMEOUT_MS}ms`))
    }, TIMEOUT_MS)

    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const text = Buffer.concat(stdout).toString('utf8').trim()
      if (!text) {
        return reject(new Error(`worker exited ${code} without output: ${Buffer.concat(stderr).toString('utf8').slice(0, 400)}`))
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error(`worker returned non-JSON output (exit ${code}): ${text.slice(0, 400)}`))
      }
    })

    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(request))
  })
}

let framing = 'line'

function send(message) {
  const body = JSON.stringify(message)
  if (framing === 'header') {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`)
  } else {
    process.stdout.write(body + '\n')
  }
}

async function handle(message) {
  const { id, method, params } = message
  const isRequest = id !== undefined && id !== null

  if (!isRequest) {
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
    return
  }

  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: (params && params.protocolVersion) || '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
      }
    })
  }

  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} })

  if (method === 'tools/list') {
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: Object.entries(TOOLS).map(([name, spec]) => ({
          name,
          description: spec.description,
          inputSchema: spec.schema
        }))
      }
    })
  }

  if (method === 'tools/call') {
    const name = params && params.name
    const spec = Object.prototype.hasOwnProperty.call(TOOLS, name) ? TOOLS[name] : null
    if (!spec) {
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true } })
    }
    try {
      const args = normalizeArgs(name, params.arguments)
      const result = await invoke(name, args)
      const failed = Boolean(result) && (
        result.status === 'error' ||
        Boolean(result.error) ||
        (typeof result.failed === 'number' && result.failed > 0)
      )
      const payload = JSON.stringify(result)
      const bytes = Buffer.byteLength(payload, 'utf8')
      if (bytes > OUTPUT_BUDGET) {
        const notice = {
          status: failed ? 'error' : 'completed',
          truncated: true,
          truncatedBy: `output-budget:${OUTPUT_BUDGET}`,
          originalBytes: bytes,
          nextAction: 'Narrow limit/offset, or page with nextOffset/continuation.',
          preview: payload.slice(0, 4000)
        }
        return send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(notice) }], ...(failed ? { isError: true } : {}) }
        })
      }
      return send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: payload }],
          ...(failed ? { isError: true } : {})
        }
      })
    } catch (error) {
      return send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `dsh-ops ${name} failed: ${error.message}` }], isError: true }
      })
    }
  }

  return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
}

let buffer = Buffer.alloc(0)

function pump() {
  for (;;) {
    if (buffer.length === 0) return
    if (buffer.slice(0, 15).toString('latin1').toLowerCase().startsWith('content-length:')) {
      const end = buffer.indexOf('\r\n\r\n')
      if (end === -1) return
      const header = buffer.slice(0, end).toString('latin1')
      const match = /content-length:\s*(\d+)/i.exec(header)
      const length = match ? Number(match[1]) : 0
      const start = end + 4
      if (buffer.length < start + length) return
      const body = buffer.slice(start, start + length).toString('utf8')
      buffer = buffer.slice(start + length)
      framing = 'header'
      safeDispatch(body)
      continue
    }
    const newline = buffer.indexOf(0x0a)
    if (newline === -1) return
    const line = buffer.slice(0, newline).toString('utf8').trim()
    buffer = buffer.slice(newline + 1)
    if (line) safeDispatch(line)
  }
}

function safeDispatch(raw) {
  let message
  try {
    message = JSON.parse(raw)
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
  }
  handle(message).catch((error) => {
    if (message && message.id !== undefined) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(error && error.message || error) } })
    }
  })
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  pump()
})
process.stderr.on('error', () => {})
process.stdout.on('error', () => process.exit(0))
process.stdin.on('end', () => process.exit(0))
