'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/registers');

const MARK = 'We need test the register. Need keep paths unchanged. Should verify evidence. Could take A or B. Must not invent. Let\'s next: run the check.';

test('chat: 新 task 前插入 assistant seed，system 追加系统寄存器', () => {
  const body = {
    model: 'deepseek-v4.1-flash-1017',
    messages: [
      { role: 'system', content: 'You are Yan.' },
      { role: 'user', content: '修复 /api/login 500' }
    ]
  };
  const result = R.injectChat(body, { seed: MARK });
  assert.equal(result.seedInjected, true);
  assert.equal(body.messages.length, 3);
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[0].content, /We need use the earlier WeNeed trace/);
  assert.equal(body.messages[1].role, 'assistant');
  assert.equal(body.messages[1].content, MARK);
  assert.equal(body.messages[1].reasoning_content, MARK);
  assert.equal(body.messages[2].role, 'user');

  const again = R.injectChat(body, { seed: MARK });
  assert.equal(again.seedInjected, false);
  assert.equal(body.messages.length, 3);
});

test('chat: 无 system 时插入一条', () => {
  const body = { messages: [{ role: 'user', content: 'hi' }] };
  R.injectChat(body, { seed: MARK });
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[0].content, /We need use the earlier WeNeed trace/);
  assert.equal(body.messages[1].role, 'assistant');
});

test('chat: 工具步只锚定，不新增消息', () => {
  const body = {
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task' },
      { role: 'assistant', content: '', reasoning_content: 'step plan', tool_calls: [{ id: '1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: '1', content: 'result' }
    ]
  };
  const result = R.injectChat(body, { seed: MARK });
  assert.equal(result.anchorInjected, true);
  assert.equal(result.seedInjected, false);
  assert.equal(body.messages.length, 4);
  assert.match(body.messages[2].reasoning_content, /^step plan/);
  assert.match(body.messages[2].reasoning_content, /Need continue from the tool result/);
  assert.match(body.messages[2].reasoning_content, /We need test the register/);
});

test('chat: team 模式追加外发规则到委派类工具描述', () => {
  const body = {
    messages: [{ role: 'user', content: 'delegate' }],
    tools: [
      { type: 'function', function: { name: 'send_agent_message', description: 'send' } },
      { type: 'function', function: { name: 'read_file', description: 'read' } }
    ]
  };
  const result = R.injectChat(body, { seed: MARK, teamHint: true });
  assert.equal(result.teamTools, 1);
  assert.match(body.tools[0].function.description, /We need every message or task sent to another agent/);
  assert.equal(body.tools[1].function.description, 'read');
});

test('目标模型：分号分组 + 组内 AND', () => {
  assert.equal(R.matchesTarget('deepseek-v4.1-flash-1017', 'deepseek,flash;weneed,ds41'), true);
  assert.equal(R.matchesTarget('x-weneed-ds41-preview', 'deepseek,flash;weneed,ds41'), true);
  assert.equal(R.matchesTarget('deepseek-v4.1-pro', 'deepseek,flash;weneed,ds41'), false);
  assert.equal(R.matchesTarget('anything', '*'), true);
  assert.equal(R.matchesTarget('', 'deepseek,flash'), false);
});

test('responses: instructions 追加，input 前插 assistant seed', () => {
  const body = {
    instructions: 'base',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'do it' }] }
    ]
  };
  const result = R.injectResponses(body, { seed: MARK });
  assert.equal(result.seedInjected, true);
  assert.match(body.instructions, /We need use the earlier WeNeed trace/);
  assert.equal(body.input.length, 2);
  assert.equal(body.input[0].role, 'assistant');
  assert.equal(body.input[1].role, 'user');
});

test('responses: 工具输出前只锚定上一条 assistant', () => {
  const body = {
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'task' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'input_text', text: 'step' }] },
      { type: 'function_call_output', call_id: '1', output: 'ok' }
    ]
  };
  const result = R.injectResponses(body, { seed: MARK });
  assert.equal(result.anchorInjected, true);
  assert.equal(body.input.length, 3);
  assert.match(body.input[1].content.map(part => part.text || '').join(''), /Need continue from the tool result/);
});

test('anthropic: 新 task 前插 assistant；tool_result 前只锚定', () => {
  const fresh = { messages: [{ role: 'user', content: [{ type: 'text', text: 'task' }] }] };
  R.injectAnthropic(fresh, { seed: MARK });
  assert.equal(fresh.messages.length, 2);
  assert.equal(fresh.messages[0].role, 'assistant');

  const tool = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'task' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] }
    ]
  };
  const result = R.injectAnthropic(tool, { seed: MARK });
  assert.equal(result.anchorInjected, true);
  assert.equal(tool.messages.length, 3);
  assert.match(tool.messages[1].content[1].text, /Need continue from the tool result/);
});

test('压缩识别与压缩寄存器', () => {
  const compaction = {
    messages: [{ role: 'system', content: 'You are a summarization assistant. Compress this conversation into a context summary.' }],
    input: undefined,
    tools: [],
    model: 'deepseek-v4.1-flash-1017'
  };
  assert.equal(R.looksLikeCompaction(compaction), true);
  const appended = R.applyCompactionRegister(compaction);
  assert.equal(appended.changed, true);
  assert.match(compaction.messages[0].content, /We need write this checkpoint/);

  const normal = { messages: [{ role: 'system', content: 'You are a coding agent.' }], tools: [{ type: 'function' }] };
  assert.equal(R.looksLikeCompaction(normal), false);
});

test('seed 组合：中文/英文都以 We need 开头并有 Must', () => {
  const zh = R.composeSeed({
    task: '修复登录接口 500',
    constraints: ['保留 /api/login'],
    nextAction: '先跑最小复现'
  });
  assert.equal(zh.language, 'zh');
  assert.match(zh.seed, /^We need/);
  assert.match(zh.seed, /Must/);
  assert.match(zh.seed, /Let's/);
  assert.ok(zh.chars <= 1600);

  const en = R.composeSeed({ task: 'fix the login 500', language: 'en' });
  assert.equal(en.language, 'en');
  assert.match(en.seed, /^We need first/);
  assert.match(en.seed, /Must/);
});

test('审计：识别第一人称/请求者描述与情态缺失', () => {
  const bad = R.auditRegister('The user wants me to fix it. I will do it now.');
  assert.equal(bad.ok, true);
  assert.equal(bad.openingOk, false);
  assert.ok(bad.issues.length >= 2);
  assert.ok(bad.score < 100);

  const good = R.auditRegister(R.composeSeed({ task: '修正测试', language: 'zh' }).seed);
  assert.equal(good.openingOk, true);
  assert.equal(good.counts.must > 0, true);
  assert.equal(good.issues.length, 0);
});