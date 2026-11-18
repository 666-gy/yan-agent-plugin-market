'use strict';

const crypto = require('node:crypto');
const { createWeneedProxy, defaultConfigPath } = require('./lib/proxy');
const daemon = require('./lib/daemon-control');
const {
  SEED,
  SYSTEM_REGISTER,
  NEAREST_GUIDANCE,
  TOOL_STEP_ANCHOR,
  TEAM_REGISTER_HINT,
  COMPACTION_REGISTER,
  TOOL_DESC_GUIDANCE,
  composeSeed,
  auditRegister,
  matchesTarget
} = require('./lib/registers');

const VERSION = '1.0.1';
const UPSTREAM_VERSION = '4.1.1';

function pick(value, allowed, fallback) {
  const text = String(value || '').trim().toLowerCase();
  return allowed.includes(text) ? text : fallback;
}

function portFromEnv(value) {
  if (value === undefined || value === '') return 8787;
  const port = Number(value);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 8787;
}

const config = {
  upstreamBaseUrl: String(process.env.WENEED_UPSTREAM_BASE_URL || ''),
  port: portFromEnv(process.env.WENEED_LISTEN_PORT),
  targetModels: String(process.env.WENEED_TARGET_MODELS || 'deepseek,flash;weneed,ds41'),
  mode: pick(process.env.WENEED_MODE, ['standard', 'goal', 'team'], 'standard'),
  seedMode: pick(process.env.WENEED_SEED_MODE, ['upstream', 'task', 'off'], 'upstream'),
  seedLanguage: pick(process.env.WENEED_SEED_LANGUAGE, ['auto', 'zh', 'en'], 'en'),
  toolStepAnchor: true,
  injectOnCompaction: false
};

const configPath = process.env.WENEED_CONFIG_PATH === undefined
  ? defaultConfigPath()
  : String(process.env.WENEED_CONFIG_PATH || '');
const proxy = createWeneedProxy({ ...config, configPath });
let startupError = '';

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
function success(id, result) { send({ jsonrpc: '2.0', id, result }); }
function failure(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }
function toolResult(id, payload) {
  const isError = payload && payload.ok === false;
  success(id, {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError
  });
}

function seedHash() {
  return crypto.createHash('sha256').update(SEED).digest('hex');
}

function daemonConfig() {
  return { ...proxy.config, configPath };
}

async function proxySummary() {
  return daemon.status(daemonConfig());
}

const tools = [
  {
    name: 'weneed_rules',
    description: '读取 We Need 4.1.1 寄存器全文（seed、system register、工具步锚、Team 外发、压缩规则）、当前代理状态和配置。激活插件后先调用一次，再按返回的规则工作。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'weneed_seed',
    description: '按任务现场组合一条 WeNeed seed：Need/Should/Could/Must/Let\'s 句式，保留目标、约束、证据与下一步。用于 seedMode=task 或无法走本地代理时的手动模式。',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '当前任务原文或摘要，必填' },
        goal: { type: 'string', description: '目标与交付物；省略时用 task' },
        language: { type: 'string', enum: ['auto', 'zh', 'en'], description: '输出语言；auto 按 task 是否含中文判断' },
        mode: { type: 'string', enum: ['standard', 'goal', 'team'], description: '寄存器模式' },
        constraints: { type: 'array', items: { type: 'string' }, description: '硬约束，逐条保留原话' },
        options: { type: 'array', items: { type: 'string' }, description: '候选路径 A/B' },
        evidence: { type: 'array', items: { type: 'string' }, description: '已有证据或输入' },
        nextAction: { type: 'string', description: '最近下一步' },
        maxChars: { type: 'integer', minimum: 200, maximum: 4000, description: 'seed 最大字符数，默认 1600' }
      },
      required: ['task'],
      additionalProperties: false
    }
  },
  {
    name: 'weneed_audit',
    description: '审计一段计划、seed 或外发 prompt 的 WeNeed 寄存器：统计 Need/Should/Could/Must/Let\'s，检查开头、Must 覆盖和第一人称/请求者描述等反模式。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要审计的文本' },
        language: { type: 'string', enum: ['auto', 'zh', 'en'], description: '语言提示' }
      },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'proxy_status',
    description: '查看本地 WeNeed 反向代理是否在监听、代理根地址、配置页地址、上游、目标模型匹配和注入计数。stats.injected 增长才说明请求被改写；running=false 时不要声称已注入。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'proxy_start',
    description: '启动或复用独立常驻的本地 WeNeed 反向代理 daemon，只绑定 127.0.0.1。可传端口和上游 API 根地址；传入的上游与注入选项会保存到本地配置文件，下次启动继续生效。端口固定，不自动顺延；被占用时会明确报错。启动后把返回的 baseUrl 作为自定义连接 Base URL，或打开返回的 configUrl 在网页里直接配置。',
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'integer', minimum: 0, maximum: 65535, description: '本地端口；0 表示系统分配' },
        upstreamBaseUrl: { type: 'string', description: '真实上游 API 根地址，例如 https://api.deepseek.com/v1' },
        targetModels: { type: 'string', description: '分号分组、逗号表示同时包含，例如 deepseek,flash;weneed,ds41' },
        mode: { type: 'string', enum: ['standard', 'goal', 'team'] },
        seedMode: { type: 'string', enum: ['upstream', 'task', 'off'] },
        seedLanguage: { type: 'string', enum: ['auto', 'zh', 'en'] }
      },
      additionalProperties: false
    }
  },
  {
    name: 'proxy_stop',
    description: '停止独立常驻的 WeNeed 反向代理 daemon 并释放端口。MCP 或内核退出不会自动停止它，只有该工具或显式结束 daemon 才会停止。停用后经过该端口的连接会失败；不会修改 Yan 的连接配置。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
];

async function rulesPayload() {
  const current = await proxySummary();
  return {
    ok: true,
    version: VERSION,
    upstreamVersion: UPSTREAM_VERSION,
    note: 'Yan 插件不能 hook 宿主模型请求；本插件用 127.0.0.1 独立 daemon 反向代理实现线级注入。代理不随 MCP 或内核进程退出。注入是概率性引导，不是硬开关。',
    seed: {
      length: SEED.length,
      sha256: seedHash(),
      text: SEED
    },
    registers: {
      system: SYSTEM_REGISTER,
      nearestGuidance: NEAREST_GUIDANCE,
      toolStepAnchor: TOOL_STEP_ANCHOR,
      teamOutgoing: TEAM_REGISTER_HINT,
      compaction: COMPACTION_REGISTER,
      toolDescription: TOOL_DESC_GUIDANCE
    },
    config: {
      upstreamBaseUrl: current.upstreamBaseUrl,
      targetModels: current.targetModels,
      mode: current.mode,
      seedMode: current.seedMode,
      seedLanguage: current.seedLanguage,
      toolStepAnchor: proxy.config.toolStepAnchor,
      configPath,
      configUrl: current.configUrl
    },
    proxy: current
  };
}

async function callTool(name, args) {
  if (name === 'weneed_rules') return rulesPayload();
  if (name === 'weneed_seed') {
    if (!args || typeof args.task !== 'string' || !args.task.trim()) return { ok: false, error: '缺少 task' };
    try {
      const composed = composeSeed(args);
      return {
        ok: true,
        ...composed,
        usage: '把 seed 放在实际任务之前；如果走本地代理，seedMode=task 会自动按最新 user task 现场组合。'
      };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
  if (name === 'weneed_audit') {
    const result = auditRegister(args && args.text, args && args.language);
    return result.ok === false ? result : { ok: true, ...result };
  }
  if (name === 'proxy_status') {
    const current = await proxySummary();
    return { ok: true, ...current, startupError };
  }
  if (name === 'proxy_start') {
    const input = args || {};
    const patch = {};
    if (typeof input.targetModels === 'string' && input.targetModels.trim()) patch.targetModels = input.targetModels.trim();
    if (input.mode) patch.mode = pick(input.mode, ['standard', 'goal', 'team'], proxy.config.mode);
    if (input.seedMode) patch.seedMode = pick(input.seedMode, ['upstream', 'task', 'off'], proxy.config.seedMode);
    if (input.seedLanguage) patch.seedLanguage = pick(input.seedLanguage, ['auto', 'zh', 'en'], proxy.config.seedLanguage);
    if (input.upstreamBaseUrl !== undefined) patch.upstreamBaseUrl = input.upstreamBaseUrl;
    if (input.port !== undefined) {
      const port = Number(input.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        return { ok: false, error: '端口无效' };
      }
      proxy.config.port = port;
    }
    try {
      if (Object.keys(patch).length) proxy.saveConfig(patch);
    } catch (error) {
      startupError = error.message;
      return { ok: false, error: error.message, ...await proxySummary() };
    }
    try {
      const state = await daemon.start(daemonConfig());
      startupError = '';
      return {
        ok: true,
        ...state,
        setup: `浏览器打开 ${state.configUrl || 'http://127.0.0.1:8787/__weneed/'} 可直接配置并保存上游地址；然后在 Yan 设置 → 模型/连接中新增自定义连接：Base URL 填 ${state.baseUrl}，API 格式选 OpenAI（或 Responses），API Key 填上游可用的 key，模型 id 填要使用的模型；然后用该连接发起请求并再次查看 proxy_status。`
      };
    } catch (error) {
      startupError = error.message;
      return { ok: false, error: error.message, ...await proxySummary() };
    }
  }
  if (name === 'proxy_stop') {
    const state = await daemon.stop(daemonConfig());
    return { ok: true, stopped: true, ...state };
  }
  return { ok: false, error: `未知工具：${name}` };
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0') return;
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'notifications/cancelled') return;
  if (message.method === 'initialize') {
    success(message.id, {
      protocolVersion: String(message.params && message.params.protocolVersion || '2025-03-26'),
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'We Need Reasoning', version: VERSION }
    });
    return;
  }
  if (message.method === 'ping') { success(message.id, {}); return; }
  if (message.method === 'tools/list') { success(message.id, { tools }); return; }
  if (message.method === 'resources/list') { success(message.id, { resources: [] }); return; }
  if (message.method === 'prompts/list') { success(message.id, { prompts: [] }); return; }
  if (message.method === 'tools/call') {
    const name = String(message.params && message.params.name || '');
    const args = (message.params && message.params.arguments) || {};
    if (!tools.some(tool => tool.name === name)) { failure(message.id, -32602, `未知工具：${name}`); return; }
    try {
      toolResult(message.id, await callTool(name, args));
    } catch (error) {
      toolResult(message.id, { ok: false, error: error && error.message || String(error) });
    }
    return;
  }
  if (message.id !== undefined) failure(message.id, -32601, `Unsupported method: ${message.method}`);
}

function serve() {
  let buffered = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffered += String(chunk || '');
    while (true) {
      const newline = buffered.indexOf('\n');
      if (newline < 0) break;
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      try { void handle(JSON.parse(line)); }
      catch (error) { failure(null, -32700, error && error.message || String(error)); }
    }
  });
  process.stdin.on('end', () => {
    // 代理由独立 daemon 持有，MCP 退出不能关闭 8787。
    process.exit(0);
  });
}

if (String(process.env.WENEED_AUTO_START || 'true').toLowerCase() !== 'false') {
  daemon.ensureStarted(daemonConfig()).catch(error => { startupError = error.message; });
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

if (require.main === module) serve();

module.exports = { tools, handle, callTool, proxy, daemon, config };