'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => res.end('busy'));
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function waitExit(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', resolve);
  });
}

function health(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1',
      port,
      path: '/__weneed/health',
      timeout: 2000
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.setTimeout(2000, () => req.destroy(new Error('健康检查超时')));
    req.on('error', reject);
  });
}

async function waitHealth(port, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const result = await health(port);
      if (result.status === 200 && result.json && result.json.service === 'weneed-proxy') return result;
      last = result;
    } catch (error) {
      last = error;
    }
    await sleep(150);
  }
  throw new Error(`代理健康检查未通过：${last && (last.message || last.text || JSON.stringify(last))}`);
}

function payloadOf(message) {
  assert.ok(message.result, `缺少 result: ${JSON.stringify(message)}`);
  return message.result.structuredContent || JSON.parse(message.result.content[0].text);
}

async function startServer(configPath, statePath, port) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.cjs')], {
    env: {
      ...process.env,
      WENEED_AUTO_START: 'true',
      WENEED_UPSTREAM_BASE_URL: 'http://127.0.0.1:9/v1',
      WENEED_LISTEN_PORT: String(port),
      WENEED_CONFIG_PATH: configPath,
      WENEED_STATE_PATH: statePath
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const request = (method, params = {}, timeout = 12000) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP 请求超时：${method}`));
    }, timeout);
    pending.set(id, message => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  return { child, request };
}

async function waitRunning(request, timeout = 12000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = payloadOf(await request('tools/call', { name: 'proxy_status', arguments: {} }, 4000));
      if (last.running) return last;
    } catch (error) {
      last = error;
    }
    await sleep(200);
  }
  throw new Error(`代理未进入 running 状态：${JSON.stringify(last)}`);
}

test('daemon：MCP 被杀后代理仍存活，重新激活可复用并安全停止', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weneed-daemon-'));
  const configPath = path.join(dir, 'config.json');
  const statePath = path.join(dir, 'daemon.json');
  const port = await freePort();
  let first = null;
  let second = null;
  try {
    first = await startServer(configPath, statePath, port);
    const started = await waitRunning(first.request);
    assert.equal(started.port, port);
    assert.equal(started.managed, true);

    const before = await waitHealth(port);
    assert.equal(before.json.service, 'weneed-proxy');
    assert.equal(before.json.pid, started.pid);

    first.child.kill('SIGKILL');
    await waitExit(first.child);

    const surviving = await waitHealth(port);
    assert.equal(surviving.json.port, port);
    assert.equal(surviving.json.pid, before.json.pid);

    second = await startServer(configPath, statePath, port);
    const reused = await waitRunning(second.request);
    assert.equal(reused.port, port);
    assert.equal(reused.pid, before.json.pid);

    const stopped = payloadOf(await second.request('tools/call', { name: 'proxy_stop', arguments: {} }));
    assert.equal(stopped.running, false);
    await assert.rejects(() => health(port));
  } finally {
    if (first && first.child.exitCode === null) {
      first.child.kill();
      await waitExit(first.child);
    }
    if (second && second.child.exitCode === null) {
      second.child.stdin.end();
      await waitExit(second.child);
    }
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (state && state.pid) process.kill(state.pid);
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});