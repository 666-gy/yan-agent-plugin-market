'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createWeneedProxy } = require('../lib/proxy');
const { SEED } = require('../lib/registers');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

test('proxy: 注入后转发、非目标透传、GET /models、SSE 流、压缩请求', async t => {
  const calls = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      calls.push({ url: req.url, headers: req.headers, body: raw });
      if (req.url === '/v1/models') {
        const payload = JSON.stringify({ data: [{ id: 'deepseek-v4.1-flash-1017' }] });
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
        res.end(payload);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  const upstreamPort = await listen(upstream);
  const proxy = createWeneedProxy({
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    targetModels: 'deepseek,flash;weneed,ds41',
    port: 0
  });
  const state = await proxy.start({ port: 0 });
  assert.equal(state.running, true);
  assert.match(state.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);

  const endpoint = `${state.baseUrl}/chat/completions`;
  const send = (body, headers = {}) => fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-secret', ...headers },
    body: JSON.stringify(body)
  });

  await t.test('目标模型：system 追加 + seed 插到 task 前', async () => {
    const response = await send({
      model: 'deepseek-v4.1-flash-1017',
      messages: [
        { role: 'system', content: 'You are Yan.' },
        { role: 'user', content: '修复 /api/login 500' }
      ]
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /\[DONE\]/);

    const call = calls.at(-1);
    assert.equal(call.url, '/v1/chat/completions');
    assert.equal(call.headers.authorization, 'Bearer test-secret');
    const body = JSON.parse(call.body);
    assert.equal(body.messages.length, 3);
    assert.match(body.messages[0].content, /We need use the earlier WeNeed trace/);
    assert.equal(body.messages[1].role, 'assistant');
    assert.equal(body.messages[1].content, SEED);
    assert.equal(body.messages[1].reasoning_content, SEED);
    assert.equal(body.messages[2].role, 'user');
  });

  await t.test('非目标模型：原样透传', async () => {
    const before = calls.length;
    const response = await send({
      model: 'glm-4-plus',
      messages: [{ role: 'user', content: '你好' }]
    });
    assert.equal(response.status, 200);
    await response.text();
    const call = calls[before];
    const body = JSON.parse(call.body);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].content, '你好');
    assert.equal(body.messages[0].role, 'user');
  });

  await t.test('GET /v1/models 转发并保留 Authorization', async () => {
    const response = await fetch(`${state.baseUrl}/models`, {
      headers: { authorization: 'Bearer test-secret' }
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data[0].id, 'deepseek-v4.1-flash-1017');
    const call = calls.at(-1);
    assert.equal(call.url, '/v1/models');
    assert.equal(call.headers.authorization, 'Bearer test-secret');
  });

  await t.test('压缩请求：只追加压缩寄存器，不插 seed', async () => {
    const before = calls.length;
    const response = await send({
      model: 'deepseek-v4.1-flash-1017',
      tools: [],
      messages: [
        { role: 'system', content: 'You are a summarization assistant. Compress this conversation into a context summary.' },
        { role: 'user', content: 'long transcript' }
      ]
    });
    assert.equal(response.status, 200);
    await response.text();
    const body = JSON.parse(calls[before].body);
    assert.equal(body.messages.length, 2);
    assert.match(body.messages.at(-1).content, /We need write this checkpoint/);
    assert.equal(body.messages.some(message => message.role === 'assistant'), false);
  });

  await t.test('状态计数', () => {
    const status = proxy.status();
    assert.equal(status.stats.injected, 2);
    assert.equal(status.stats.passthrough >= 1, true);
    assert.equal(status.stats.lastModel, 'deepseek-v4.1-flash-1017');
    assert.equal(status.stats.errors, 0);
  });

  await proxy.stop();
  await close(upstream);
});

test('proxy: 固定端口被占用时不静默顺延', async () => {
  const occupied = http.createServer((req, res) => res.end('occupied'));
  const port = await listen(occupied);
  const proxy = createWeneedProxy({
    port,
    upstreamBaseUrl: 'http://127.0.0.1:9/v1',
    configPath: ''
  });
  try {
    await assert.rejects(
      () => proxy.start({ port, exactPort: true }),
      /已被占用.*不会自动顺延/
    );
    assert.equal(proxy.status().running, false);
  } finally {
    await proxy.stop();
    await close(occupied);
  }
});