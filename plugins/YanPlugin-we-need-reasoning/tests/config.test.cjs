'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWeneedProxy } = require('../lib/proxy');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => {
    if (!server || !server.listening) { resolve(); return; }
    server.close(() => resolve());
  });
}

function request(port, target, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: target,
      method: options.method || 'GET',
      headers: options.headers || {}
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test('proxy: 配置页、保存上游、持久化与来源校验', async t => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const upstreamPort = await listen(upstream);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weneed-config-'));
  const configPath = path.join(dir, 'config.json');
  const proxy = createWeneedProxy({ configPath, port: 0 });
  const state = await proxy.start({ port: 0 });
  const base = `http://127.0.0.1:${state.port}`;

  t.after(async () => {
    await proxy.stop();
    await close(upstream);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('配置页可打开', async () => {
    const page = await request(state.port, '/__weneed/');
    assert.equal(page.status, 200);
    assert.match(String(page.headers['content-type']), /text\/html/);
    assert.match(page.text, /上游 API 根地址/);
    assert.match(page.text, /保存并应用/);
  });

  await t.test('初始配置没有上游', async () => {
    const response = await request(state.port, '/__weneed/config');
    assert.equal(response.status, 200);
    const data = JSON.parse(response.text);
    assert.equal(data.ok, true);
    assert.equal(data.upstreamBaseUrl, '');
    assert.equal(data.configUrl, `${base}/__weneed/`);
    assert.equal(data.persisted, true);
  });

  const saved = {
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    targetModels: 'deepseek,flash',
    mode: 'goal',
    seedMode: 'task',
    seedLanguage: 'zh'
  };

  await t.test('保存配置并立即生效', async () => {
    proxy.stats.lastError = '旧错误';
    const response = await request(state.port, '/__weneed/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify(saved)
    });
    assert.equal(response.status, 200);
    const data = JSON.parse(response.text);
    assert.equal(data.ok, true);
    assert.equal(data.upstreamBaseUrl, saved.upstreamBaseUrl);
    assert.equal(data.mode, 'goal');
    assert.equal(data.seedMode, 'task');
    assert.equal(proxy.stats.lastError, '');
    const stored = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(stored.upstreamBaseUrl, saved.upstreamBaseUrl);
    assert.equal(stored.targetModels, 'deepseek,flash');
  });

  await t.test('跨站来源被拒绝', async () => {
    const response = await request(state.port, '/__weneed/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ upstreamBaseUrl: 'https://evil.example/v1' })
    });
    assert.equal(response.status, 403);
    const stored = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(stored.upstreamBaseUrl, saved.upstreamBaseUrl);
  });

  await t.test('非法上游被拒绝', async () => {
    const response = await request(state.port, '/__weneed/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ upstreamBaseUrl: 'ftp://example.com/v1' })
    });
    assert.equal(response.status, 400);
    const stored = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(stored.upstreamBaseUrl, saved.upstreamBaseUrl);
  });

  await t.test('非 JSON 写入被拒绝', async () => {
    const response = await request(state.port, '/__weneed/config', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: base },
      body: JSON.stringify({ upstreamBaseUrl: 'https://example.com/v1' })
    });
    assert.equal(response.status, 415);
  });

  await t.test('重启后从配置文件恢复', async () => {
    const restarted = createWeneedProxy({ configPath, port: 0 });
    const state2 = await restarted.start({ port: 0 });
    assert.equal(state2.upstreamBaseUrl, saved.upstreamBaseUrl);
    assert.equal(state2.mode, 'goal');
    assert.equal(state2.seedMode, 'task');
    await restarted.stop();
  });
});