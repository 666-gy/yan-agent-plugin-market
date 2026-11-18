'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const START_TIMEOUT_MS = 8000;
const STOP_TIMEOUT_MS = 5000;

function defaultStatePath() {
  const custom = String(process.env.WENEED_STATE_PATH || '').trim();
  return custom ? path.resolve(custom) : path.join(os.homedir(), '.weneed-reasoning', 'daemon.json');
}

function readState() {
  try {
    const value = JSON.parse(fs.readFileSync(defaultStatePath(), 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function writeState(value) {
  const file = defaultStatePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function removeState() {
  try { fs.unlinkSync(defaultStatePath()); } catch {}
}

function validPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body), 'utf8');
    const headers = { accept: 'application/json', ...(options.headers || {}) };
    if (options.token) headers['x-weneed-control'] = options.token;
    if (body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(body.length);
    }
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: options.method || 'GET',
      headers
    }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size <= 1024 * 1024) chunks.push(chunk);
      });
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        text: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.setTimeout(options.timeout || 900, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function probe(port) {
  if (!validPort(port)) return { ok: false, running: false, port: Number(port) || 0 };
  try {
    const health = await request(port, '/__weneed/health');
    if (health.status === 200) {
      let data = null;
      try { data = JSON.parse(health.text); } catch {}
      if (data && data.ok && data.service === 'weneed-proxy') {
        return { ...data, ok: true, running: true, managed: Boolean(data.managed), legacy: false };
      }
    }
  } catch {}
  try {
    const page = await request(port, '/__weneed/');
    if (page.status === 200 && /We Need Reasoning · 代理配置/.test(page.text)) {
      return {
        ok: true,
        running: true,
        managed: false,
        legacy: true,
        port: Number(port),
        baseUrl: `http://127.0.0.1:${port}/v1`,
        configUrl: `http://127.0.0.1:${port}/__weneed/`,
        warning: '检测到旧版进程内代理，当前新 daemon 无法控制它。请停用旧插件实例后再启动。'
      };
    }
  } catch {}
  return { ok: false, running: false, port: Number(port) || 0 };
}

function redactBase(value) {
  try {
    const parsed = new URL(String(value || ''));
    parsed.username = '';
    parsed.password = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return String(value || '');
  }
}

function baseOf(config) {
  try {
    return String(new URL(String(config.upstreamBaseUrl || '')).toString()).replace(/\/+$/, '');
  } catch {
    return String(config.upstreamBaseUrl || '').replace(/\/+$/, '');
  }
}

function publicStatus(config) {
  return {
    upstreamBaseUrl: redactBase(config.upstreamBaseUrl),
    targetModels: config.targetModels,
    mode: config.mode,
    seedMode: config.seedMode,
    seedLanguage: config.seedLanguage,
    configPath: config.configPath || ''
  };
}

function sameConfig(status, config) {
  const left = String(status.upstreamBaseUrl || '').replace(/\/+$/, '');
  return left === baseOf(config)
    && status.targetModels === config.targetModels
    && status.mode === config.mode
    && status.seedMode === config.seedMode
    && status.seedLanguage === config.seedLanguage;
}

async function status(config = {}) {
  const ports = [];
  if (validPort(config.port)) ports.push(Number(config.port));
  const state = readState();
  if (state && validPort(state.port) && !ports.includes(Number(state.port))) ports.unshift(Number(state.port));
  for (const port of ports) {
    const current = await probe(port);
    if (current.ok) {
      return {
        ...publicStatus(config),
        ...current,
        port,
        configPath: config.configPath || '',
        configUrl: current.configUrl || `http://127.0.0.1:${port}/__weneed/`,
        baseUrl: current.baseUrl || `http://127.0.0.1:${port}/v1`
      };
    }
  }
  return {
    ...publicStatus(config),
    ok: true,
    running: false,
    managed: false,
    legacy: false,
    port: Number(config.port) || 0,
    baseUrl: '',
    configUrl: ''
  };
}

function spawnDaemon(config) {
  // 清掉上一次启动失败留下的 error 状态，避免 waitForStart 误读旧错误。
  removeState();
  const daemonPath = path.join(__dirname, 'daemon.js');
  const env = {
    ...process.env,
    WENEED_DAEMON: '1',
    WENEED_STATE_PATH: defaultStatePath(),
    WENEED_LISTEN_PORT: String(config.port),
    WENEED_UPSTREAM_BASE_URL: String(config.upstreamBaseUrl || ''),
    WENEED_TARGET_MODELS: String(config.targetModels || ''),
    WENEED_MODE: String(config.mode || ''),
    WENEED_SEED_MODE: String(config.seedMode || ''),
    WENEED_SEED_LANGUAGE: String(config.seedLanguage || '')
  };
  if (config.configPath) env.WENEED_CONFIG_PATH = String(config.configPath);
  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env
  });
  child.unref();
  return child;
}

async function waitForStart(config) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = readState();
    if (state && state.status === 'error' && state.error) throw new Error(String(state.error));
    if (state && validPort(state.port)) {
      const current = await probe(Number(state.port));
      if (current.ok && current.service === 'weneed-proxy') return current;
      if (current.legacy) throw new Error(String(current.warning || '旧版代理占用了端口'));
    }
    if (validPort(config.port)) {
      const current = await probe(Number(config.port));
      if (current.ok && current.service === 'weneed-proxy') return current;
      if (current.legacy) throw new Error(String(current.warning || '旧版代理占用了端口'));
    }
    await delay(120);
  }
  throw new Error(`代理 daemon 未在 ${START_TIMEOUT_MS / 1000} 秒内启动；请检查端口 ${config.port} 是否被占用。`);
}

async function ensureStarted(config) {
  const current = await status(config);
  if (current.running) {
    if (current.legacy) throw new Error(current.warning);
    return current;
  }
  spawnDaemon(config);
  return waitForStart(config);
}

async function start(config) {
  const current = await status(config);
  if (current.running) {
    if (current.legacy) throw new Error(current.warning);
    if ((Number(config.port) === 0 || Number(current.port) === Number(config.port)) && sameConfig(current, config)) {
      return current;
    }
    await stop(config);
  }
  spawnDaemon(config);
  return waitForStart(config);
}

async function waitForPortClosed(port) {
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await probe(port);
    if (!current.ok) return;
    await delay(100);
  }
  throw new Error(`端口 ${port} 仍在监听，代理未能停止`);
}

async function stop(config) {
  const current = await status(config);
  if (!current.running) {
    removeState();
    return { ...current, ok: true, stopped: true, running: false };
  }
  if (current.legacy) throw new Error(current.warning);
  const state = readState();
  if (!state || !state.token) throw new Error('找不到 daemon 控制状态文件，无法安全停止代理');
  try {
    const result = await request(current.port, '/__weneed/control', {
      method: 'POST',
      token: state.token,
      body: { action: 'stop' },
      timeout: 1500
    });
    if (result.status !== 200) {
      let detail = result.text;
      try { detail = JSON.parse(result.text).error || detail; } catch {}
      throw new Error(`控制端点返回 HTTP ${result.status}${detail ? `：${detail}` : ''}`);
    }
  } catch (error) {
    throw new Error(`停止代理失败：${error.message}`);
  }
  await waitForPortClosed(current.port);
  removeState();
  return { ...current, ok: true, stopped: true, running: false, baseUrl: '', configUrl: '' };
}

module.exports = {
  defaultStatePath,
  readState,
  writeState,
  removeState,
  probe,
  status,
  ensureStarted,
  start,
  stop
};