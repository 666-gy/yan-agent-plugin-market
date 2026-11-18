'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

async function startServer(configPath) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.cjs')], {
    env: {
      ...process.env,
      WENEED_AUTO_START: 'false',
      WENEED_UPSTREAM_BASE_URL: 'http://127.0.0.1:9/v1',
      WENEED_LISTEN_PORT: '0',
      WENEED_CONFIG_PATH: configPath,
      WENEED_STATE_PATH: path.join(path.dirname(configPath), 'daemon.json')
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
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP 请求超时：${method}`));
    }, 8000);
    pending.set(id, message => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  return { child, request };
}

function payloadOf(message) {
  assert.ok(message.result, `缺少 result: ${JSON.stringify(message)}`);
  return message.result.structuredContent || JSON.parse(message.result.content[0].text);
}

test('MCP：握手、工具清单、seed/审计/状态/启停', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weneed-mcp-'));
  const configPath = path.join(dir, 'config.json');
  const { child, request } = await startServer(configPath);
  try {
    const init = await request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'weneed-test', version: '1.0.0' }
    });
    assert.equal(init.result.protocolVersion, '2025-03-26');
    assert.equal(init.result.serverInfo.name, 'We Need Reasoning');
    assert.equal(init.result.serverInfo.version, '1.0.2');

    const list = await request('tools/list');
    const names = list.result.tools.map(tool => tool.name).sort();
    assert.deepEqual(names, ['proxy_start', 'proxy_status', 'proxy_stop', 'weneed_audit', 'weneed_rules', 'weneed_seed']);

    const rules = payloadOf(await request('tools/call', { name: 'weneed_rules', arguments: {} }));
    assert.equal(rules.ok, true);
    assert.equal(rules.upstreamVersion, '4.1.1');
    assert.ok(rules.seed.text.length > 900);
    assert.match(rules.registers.system, /We need use the earlier WeNeed trace/);

    const seed = payloadOf(await request('tools/call', {
      name: 'weneed_seed',
      arguments: { task: '修复登录接口 500', constraints: ['保留 /api/login'], nextAction: '先复现' }
    }));
    assert.equal(seed.ok, true);
    assert.match(seed.seed, /^We need/);
    assert.match(seed.seed, /Must/);

    const audit = payloadOf(await request('tools/call', {
      name: 'weneed_audit',
      arguments: { text: 'The user wants me to fix it. I will do it now.' }
    }));
    assert.equal(audit.ok, true);
    assert.equal(audit.openingOk, false);
    assert.ok(audit.issues.length > 0);

    const before = payloadOf(await request('tools/call', { name: 'proxy_status', arguments: {} }));
    assert.equal(before.running, false);

    const started = payloadOf(await request('tools/call', {
      name: 'proxy_start',
      arguments: { port: 0, upstreamBaseUrl: 'http://127.0.0.1:9/v1' }
    }));
    assert.equal(started.ok, true);
    assert.equal(started.running, true);
    assert.match(started.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    const stored = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(stored.upstreamBaseUrl, 'http://127.0.0.1:9/v1');

    const during = payloadOf(await request('tools/call', { name: 'proxy_status', arguments: {} }));
    assert.equal(during.running, true);
    assert.equal(during.upstreamBaseUrl, 'http://127.0.0.1:9/v1');

    const stopped = payloadOf(await request('tools/call', { name: 'proxy_stop', arguments: {} }));
    assert.equal(stopped.ok, true);
    assert.equal(stopped.running, false);
  } finally {
    child.stdin.end();
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});