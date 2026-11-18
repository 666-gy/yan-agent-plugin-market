'use strict';

const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { URL } = require('node:url');
const {
  SEED,
  matchesTarget,
  looksLikeCompaction,
  applyCompactionRegister,
  applyRequest,
  composeSeed,
  textOfContent
} = require('./registers');

const MAX_BODY = 64 * 1024 * 1024;
const HOP_HEADERS = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding', 'proxy-connection',
  'keep-alive', 'upgrade', 'te', 'trailer'
]);

function normalizeBase(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const url = new URL(text);
  if (!/^https?:$/.test(url.protocol)) throw new Error('upstreamBaseUrl 只支持 http/https');
  url.username = '';
  url.password = '';
  return url.toString().replace(/\/+$/, '');
}

function publicBase(value) {
  try {
    const url = new URL(String(value || ''));
    return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/, '');
  } catch { return ''; }
}

const STORED_KEYS = ['upstreamBaseUrl', 'targetModels', 'mode', 'seedMode', 'seedLanguage'];
const MODES = ['standard', 'goal', 'team'];
const SEED_MODES = ['upstream', 'task', 'off'];
const SEED_LANGUAGES = ['auto', 'zh', 'en'];

function defaultConfigPath() {
  return path.join(os.homedir(), '.weneed-reasoning', 'config.json');
}

function normalizeStored(values) {
  const result = {};
  if (!values || typeof values !== 'object') return result;
  if (values.upstreamBaseUrl !== undefined) {
    try { result.upstreamBaseUrl = normalizeBase(values.upstreamBaseUrl); } catch {}
  }
  if (typeof values.targetModels === 'string' && values.targetModels.trim()) {
    result.targetModels = values.targetModels.trim();
  }
  if (MODES.includes(values.mode)) result.mode = values.mode;
  if (SEED_MODES.includes(values.seedMode)) result.seedMode = values.seedMode;
  if (SEED_LANGUAGES.includes(values.seedLanguage)) result.seedLanguage = values.seedLanguage;
  return result;
}

function readStoredConfig(file) {
  if (!file) return {};
  try { return normalizeStored(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch { return {}; }
}

function writeStoredConfig(file, values) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(values, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function configPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>We Need Reasoning · 代理配置</title>
<style>
:root{color-scheme:light;--bg:#f5f6f8;--card:#fff;--line:#e3e6ea;--ink:#1c2024;--muted:#6b7480;--accent:#2563eb;--good:#15803d;--bad:#b91c1c}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
main{max-width:720px;margin:0 auto;padding:40px 20px 56px}
header{margin-bottom:20px}
h1{font-size:24px;margin:0 0 4px;letter-spacing:-.02em}
.sub{margin:0;color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:14px}
.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.row span{color:var(--muted)}
code{background:#f1f3f5;border:1px solid var(--line);border-radius:6px;padding:4px 8px;font-size:13px;word-break:break-all}
button{border:1px solid var(--line);background:#fff;color:var(--ink);border-radius:7px;padding:7px 12px;font:inherit;cursor:pointer}
button:hover{background:#f7f8fa}
.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.primary:hover{background:#1d4ed8}
.hint{color:var(--muted);font-size:13px;margin:8px 0 0}
label{display:block;font-weight:600;margin-bottom:12px}
input,select{display:block;width:100%;margin-top:6px;padding:9px 10px;border:1px solid var(--line);border-radius:7px;font:inherit;background:#fff;color:var(--ink)}
input:focus,select:focus{outline:2px solid #bfdbfe;border-color:var(--accent)}
.req{color:var(--bad);font-weight:500;font-size:12px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}
@media(max-width:560px){.grid{grid-template-columns:1fr}}
.actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:4px}
.msg{font-size:13px}.msg.good{color:var(--good)}.msg.bad{color:var(--bad)}
footer{color:var(--muted);font-size:12px;margin-top:18px;word-break:break-all}
</style>
</head>
<body>
<main>
<header>
<h1>We Need Reasoning</h1>
<p class="sub">本地代理配置 · 只监听 127.0.0.1</p>
</header>
<section class="card">
<div class="row"><span>代理 Base URL</span><code id="baseUrl">—</code><button type="button" id="copy">复制</button></div>
<p class="hint">把这个地址填到 Yan 的模型连接 Base URL。API Key 仍由 Yan 保存；本页不读取、不保存密钥。</p>
</section>
<form id="form" class="card">
<label>上游 API 根地址 <span class="req">必填</span>
<input id="upstream" type="url" placeholder="https://api.deepseek.com/v1" spellcheck="false">
</label>
<p class="hint">代理只把请求转发到这个地址。留空时请求会返回 502。</p>
<div class="grid">
<label>目标模型匹配
<input id="targetModels" placeholder="deepseek,flash;weneed,ds41" spellcheck="false">
</label>
<label>寄存器模式
<select id="mode"><option value="standard">standard</option><option value="goal">goal</option><option value="team">team</option></select>
</label>
<label>Seed 来源
<select id="seedMode"><option value="upstream">upstream（原文）</option><option value="task">task（按任务组合）</option><option value="off">off（只注入系统规则）</option></select>
</label>
<label>Seed 语言
<select id="seedLanguage"><option value="en">en</option><option value="zh">zh</option><option value="auto">auto</option></select>
</label>
</div>
<div class="actions">
<button type="submit" class="primary">保存并应用</button>
<button type="button" id="reload">重新读取</button>
<span id="msg" class="msg"></span>
</div>
</form>
<footer><span id="configPath"></span></footer>
</main>
<script>
var $ = function (id) { return document.getElementById(id); };
var state = { baseUrl: '' };
function setMsg(text, kind) {
  var el = $('msg');
  el.textContent = text || '';
  el.className = 'msg ' + (kind || '');
}
function request(path, options) {
  return fetch(path, options).then(function (res) {
    return res.json().catch(function () { return { ok: false, error: '响应不是 JSON' }; }).then(function (data) {
      if (!res.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + res.status));
      return data;
    });
  });
}
function fill(data) {
  state.baseUrl = data.baseUrl || '';
  $('baseUrl').textContent = state.baseUrl || '（代理未运行）';
  $('upstream').value = data.upstreamBaseUrl || '';
  $('targetModels').value = data.targetModels || '';
  $('mode').value = data.mode || 'standard';
  $('seedMode').value = data.seedMode || 'upstream';
  $('seedLanguage').value = data.seedLanguage || 'en';
  $('configPath').textContent = data.configPath ? ('配置文件：' + data.configPath) : '当前未启用持久化';
}
function load() {
  request('/__weneed/config').then(function (data) {
    fill(data);
    setMsg('', '');
  }).catch(function (error) { setMsg(error.message, 'bad'); });
}
$('form').addEventListener('submit', function (event) {
  event.preventDefault();
  setMsg('保存中…', '');
  var body = {
    upstreamBaseUrl: $('upstream').value.trim(),
    targetModels: $('targetModels').value.trim(),
    mode: $('mode').value,
    seedMode: $('seedMode').value,
    seedLanguage: $('seedLanguage').value
  };
  request('/__weneed/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function (data) {
    fill(data);
    setMsg('已保存并立即生效', 'good');
  }).catch(function (error) { setMsg(error.message, 'bad'); });
});
$('reload').addEventListener('click', load);
$('copy').addEventListener('click', function () {
  navigator.clipboard.writeText(state.baseUrl).then(function () {
    setMsg('Base URL 已复制', 'good');
  }).catch(function () { setMsg('复制失败，请手动选择', 'bad'); });
});
load();
</script>
</body>
</html>`;
}

function joinUpstream(base, pathname, search) {
  const url = new URL(base);
  let path = pathname || '/';
  // 客户端指向 http://127.0.0.1:PORT/v1，上游根地址可能已带 /v1；
  // 先去掉本地 /v1 前缀，再拼到上游根路径，避免出现 /v1/v1。
  if (path === '/v1') path = '/';
  else if (path.startsWith('/v1/')) path = path.slice(3);
  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = `${basePath}${path.startsWith('/') ? path : `/${path}`}`.replace(/\/{2,}/g, '/') || '/';
  url.search = search || '';
  return url;
}

function decodeBody(buffer, encoding) {
  const value = String(encoding || '').toLowerCase();
  try {
    if (value === 'gzip') return zlib.gunzipSync(buffer);
    if (value === 'deflate') return zlib.inflateSync(buffer);
    if (value === 'br') return zlib.brotliDecompressSync(buffer);
  } catch {
    return null;
  }
  return buffer;
}

function lastUserText(body) {
  if (Array.isArray(body.messages)) {
    for (let index = body.messages.length - 1; index >= 0; index -= 1) {
      const message = body.messages[index];
      if (message && message.role === 'user') {
        const text = textOfContent(message.content).trim();
        if (text) return text;
      }
    }
  }
  if (typeof body.input === 'string') return body.input.trim();
  if (Array.isArray(body.input)) {
    for (let index = body.input.length - 1; index >= 0; index -= 1) {
      const item = body.input[index];
      if (item && item.role === 'user') {
        const text = textOfContent(item.content).trim();
        if (text) return text;
      }
    }
  }
  return '';
}

function sameToken(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createWeneedProxy(options = {}) {
  const configPath = options.configPath === undefined ? '' : String(options.configPath || '');
  const persisted = readStoredConfig(configPath);
  const version = String(options.version || '1.0.1');
  const controlToken = String(options.controlToken || '');
  const onStopRequested = typeof options.onStopRequested === 'function' ? options.onStopRequested : null;
  const allowPortShift = options.allowPortShift === true;
  const startedAt = Date.now();
  const config = {
    host: '127.0.0.1',
    port: 8787,
    upstreamBaseUrl: '',
    targetModels: 'deepseek,flash;weneed,ds41',
    mode: 'standard',
    seedMode: 'upstream',
    seedLanguage: 'en',
    toolStepAnchor: true,
    injectOnCompaction: false
  };
  if (options.host !== undefined) config.host = String(options.host || '127.0.0.1');
  if (options.port !== undefined) {
    const port = Number(options.port);
    config.port = Number.isFinite(port) ? port : 8787;
  }
  for (const key of STORED_KEYS) {
    if (options[key] !== undefined) config[key] = options[key];
  }
  if (options.toolStepAnchor !== undefined) config.toolStepAnchor = options.toolStepAnchor;
  if (options.injectOnCompaction !== undefined) config.injectOnCompaction = options.injectOnCompaction;
  // 网页/文件保存的值优先于插件配置（环境变量），避免用户每次启动都要重填上游。
  for (const key of STORED_KEYS) {
    if (persisted[key] !== undefined) config[key] = persisted[key];
  }
  const stats = {
    requests: 0,
    injected: 0,
    passthrough: 0,
    errors: 0,
    lastModel: '',
    lastPath: '',
    lastAt: 0,
    lastInjectedAt: 0,
    lastError: '',
    lastActions: [],
    lastStatus: 0
  };
  let server = null;
  let listeningPort = 0;
  let startPromise = null;

  function status() {
    return {
      running: Boolean(server && server.listening),
      service: 'weneed-proxy',
      version,
      managed: Boolean(controlToken),
      pid: process.pid,
      startedAt,
      baseUrl: listeningPort ? `http://127.0.0.1:${listeningPort}/v1` : '',
      port: listeningPort,
      configUrl: listeningPort ? `http://127.0.0.1:${listeningPort}/__weneed/` : '',
      configPath,
      upstreamBaseUrl: publicBase(config.upstreamBaseUrl),
      targetModels: config.targetModels,
      mode: config.mode,
      seedMode: config.seedMode,
      seedLanguage: config.seedLanguage,
      stats: { ...stats, lastActions: [...stats.lastActions] }
    };
  }

  function replyJson(res, statusCode, payload) {
    if (res.headersSent) { res.end(); return; }
    const text = JSON.stringify(payload);
    res.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store'
    });
    res.end(text);
  }

  function configPayload() {
    const current = status();
    return {
      ok: true,
      running: current.running,
      baseUrl: current.baseUrl,
      configUrl: current.configUrl,
      upstreamBaseUrl: current.upstreamBaseUrl,
      targetModels: config.targetModels,
      mode: config.mode,
      seedMode: config.seedMode,
      seedLanguage: config.seedLanguage,
      configPath,
      persisted: Boolean(configPath)
    };
  }

  function preparePatch(patch = {}) {
    const next = {};
    if (patch.upstreamBaseUrl !== undefined) {
      next.upstreamBaseUrl = normalizeBase(patch.upstreamBaseUrl);
    }
    if (patch.targetModels !== undefined) {
      const text = String(patch.targetModels || '').trim();
      if (!text) throw new Error('targetModels 不能为空');
      next.targetModels = text;
    }
    if (patch.mode !== undefined) {
      const value = String(patch.mode || '').trim().toLowerCase();
      if (!MODES.includes(value)) throw new Error('mode 只能是 standard / goal / team');
      next.mode = value;
    }
    if (patch.seedMode !== undefined) {
      const value = String(patch.seedMode || '').trim().toLowerCase();
      if (!SEED_MODES.includes(value)) throw new Error('seedMode 只能是 upstream / task / off');
      next.seedMode = value;
    }
    if (patch.seedLanguage !== undefined) {
      const value = String(patch.seedLanguage || '').trim().toLowerCase();
      if (!SEED_LANGUAGES.includes(value)) throw new Error('seedLanguage 只能是 auto / zh / en');
      next.seedLanguage = value;
    }
    return next;
  }

  function saveConfig(patch = {}) {
    const next = preparePatch(patch);
    if (!Object.keys(next).length) return { ok: true, applied: next, configPath };
    if (configPath) {
      const stored = readStoredConfig(configPath);
      writeStoredConfig(configPath, { ...stored, ...next });
    }
    Object.assign(config, next);
    if (config.upstreamBaseUrl) stats.lastError = '';
    return { ok: true, applied: next, configPath };
  }

  function handleConfigPost(req, res) {
    const origin = String(req.headers.origin || '');
    if (origin) {
      try {
        const source = new URL(origin);
        const localHost = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(source.hostname);
        const sourcePort = source.port || (source.protocol === 'https:' ? '443' : '80');
        if (!localHost || sourcePort !== String(listeningPort)) {
          replyJson(res, 403, { ok: false, error: '只接受来自本配置页的保存请求' });
          return;
        }
      } catch {
        replyJson(res, 403, { ok: false, error: '来源地址无效' });
        return;
      }
    }
    if (!/application\/json/i.test(String(req.headers['content-type'] || ''))) {
      replyJson(res, 415, { ok: false, error: 'Content-Type 必须是 application/json' });
      return;
    }
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', chunk => {
      if (aborted) return;
      size += chunk.length;
      if (size > 64 * 1024) {
        aborted = true;
        replyJson(res, 413, { ok: false, error: '配置请求超过 64 KB' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const saved = saveConfig(body);
        replyJson(res, 200, { ...configPayload(), ...saved });
      } catch (error) {
        replyJson(res, 400, { ok: false, error: String(error && error.message || error) });
      }
    });
    req.on('error', () => {
      if (aborted) return;
      aborted = true;
      replyJson(res, 400, { ok: false, error: '读取配置请求失败' });
    });
  }

  function seedFor(body) {
    if (config.seedMode === 'off') return '';
    if (config.seedMode === 'task') {
      const task = lastUserText(body);
      if (!task) return SEED;
      try {
        return composeSeed({ task, language: config.seedLanguage, mode: config.mode }).seed;
      } catch { return SEED; }
    }
    return SEED;
  }

  function injectJson(body, pathname) {
    if (looksLikeCompaction(body)) {
      const compaction = applyCompactionRegister(body);
      return {
        changed: compaction.changed,
        actions: compaction.actions,
        seedInjected: false,
        anchorInjected: false,
        teamTools: 0,
        compaction: true
      };
    }
    const seed = seedFor(body);
    return {
      ...applyRequest(body, pathname, {
        seed,
        injectSeed: config.seedMode !== 'off',
        injectSystem: true,
        toolStepAnchor: config.toolStepAnchor !== false,
        teamHint: config.mode === 'team'
      }),
      compaction: false
    };
  }

  function forward(req, res, upstream, body, headers) {
    const transport = upstream.protocol === 'https:' ? https : http;
    const requestOptions = {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: `${upstream.pathname}${upstream.search}`,
      headers,
      timeout: 0
    };
    const upstreamReq = transport.request(requestOptions, upstreamRes => {
      const responseHeaders = {};
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (key === 'connection' || key === 'transfer-encoding' || key === 'keep-alive') continue;
        responseHeaders[key] = value;
      }
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      upstreamRes.pipe(res);
      upstreamRes.on('error', error => {
        stats.errors += 1;
        stats.lastError = String(error && error.message || error).slice(0, 200);
        res.destroy();
      });
    });
    upstreamReq.on('error', error => {
      stats.errors += 1;
      stats.lastError = String(error && error.message || error).slice(0, 200);
      replyJson(res, 502, {
        error: {
          type: 'weneed_upstream_error',
          message: 'WeNeed 代理无法连接上游 API。请检查 upstreamBaseUrl、网络和证书。',
          detail: stats.lastError
        }
      });
    });
    req.on('aborted', () => upstreamReq.destroy());
    res.on('close', () => { if (!res.writableEnded) upstreamReq.destroy(); });
    if (body && body.length) upstreamReq.write(body);
    upstreamReq.end();
  }

  function handleControl(req, res) {
    if (String(req.method || '').toUpperCase() !== 'POST') {
      replyJson(res, 405, { ok: false, error: '控制端点只支持 POST' });
      return;
    }
    if (!controlToken || !sameToken(req.headers['x-weneed-control'], controlToken)) {
      replyJson(res, 403, { ok: false, error: '控制令牌无效' });
      return;
    }
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', chunk => {
      if (aborted) return;
      size += chunk.length;
      if (size > 64 * 1024) {
        aborted = true;
        replyJson(res, 413, { ok: false, error: '控制请求超过 64 KB' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const action = String(body.action || 'status');
        if (action === 'status') { replyJson(res, 200, { ok: true, ...status() }); return; }
        if (action === 'stop') {
          replyJson(res, 200, { ok: true, stopping: true, ...status() });
          setTimeout(() => { if (onStopRequested) onStopRequested(); }, 50);
          return;
        }
        replyJson(res, 400, { ok: false, error: `未知控制动作：${action}` });
      } catch (error) {
        replyJson(res, 400, { ok: false, error: String(error && error.message || error) });
      }
    });
    req.on('error', () => {
      if (aborted) return;
      aborted = true;
      replyJson(res, 400, { ok: false, error: '读取控制请求失败' });
    });
  }

  function handle(req, res) {
    const parsed = new URL(req.url || '/', 'http://127.0.0.1');
    if (parsed.pathname === '/__weneed/health') {
      replyJson(res, 200, { ok: true, ...status() });
      return;
    }
    if (parsed.pathname === '/__weneed/control') {
      handleControl(req, res);
      return;
    }
    if (parsed.pathname === '/__weneed/status') {
      replyJson(res, 200, { ok: true, ...status() });
      return;
    }
    if (parsed.pathname === '/__weneed' || parsed.pathname === '/__weneed/') {
      const html = configPage();
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(html),
        'cache-control': 'no-store'
      });
      res.end(html);
      return;
    }
    if (parsed.pathname === '/__weneed/config') {
      const method = String(req.method || '').toUpperCase();
      if (method === 'GET') { replyJson(res, 200, configPayload()); return; }
      if (method === 'POST') { handleConfigPost(req, res); return; }
      replyJson(res, 405, { ok: false, error: '只支持 GET / POST' });
      return;
    }
    if (parsed.pathname.startsWith('/__weneed/')) {
      replyJson(res, 404, { ok: false, error: '未知的 WeNeed 代理端点' });
      return;
    }

    stats.requests += 1;
    stats.lastAt = Date.now();
    stats.lastPath = parsed.pathname;

    if (!config.upstreamBaseUrl) {
      stats.errors += 1;
      stats.lastError = 'upstreamBaseUrl 未配置';
      replyJson(res, 502, {
        error: {
          type: 'weneed_config_error',
          message: '尚未配置 upstreamBaseUrl。请在插件配置中填写真实 API 根地址，或调用 proxy_start 传入 upstreamBaseUrl。'
        }
      });
      return;
    }

    const upstream = joinUpstream(config.upstreamBaseUrl, parsed.pathname, parsed.search);
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (HOP_HEADERS.has(key.toLowerCase())) continue;
      headers[key] = value;
    }
    headers.host = upstream.host;

    const collect = (callback) => {
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > MAX_BODY) {
        stats.errors += 1;
        replyJson(res, 413, { error: { type: 'weneed_body_too_large', message: '请求体超过 64 MB，代理拒绝处理。' } });
        req.destroy();
        return;
      }
      const chunks = [];
      let size = 0;
      let aborted = false;
      req.on('data', chunk => {
        if (aborted) return;
        size += chunk.length;
        if (size > MAX_BODY) {
          aborted = true;
          stats.errors += 1;
          replyJson(res, 413, { error: { type: 'weneed_body_too_large', message: '请求体超过 64 MB，代理拒绝处理。' } });
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => { if (!aborted) callback(Buffer.concat(chunks)); });
      req.on('error', () => { if (!aborted) replyJson(res, 400, { error: { type: 'weneed_request_error', message: '读取本地请求失败。' } }); });
    };

    if (!['POST', 'PUT', 'PATCH'].includes(String(req.method || '').toUpperCase())) {
      stats.passthrough += 1;
      forward(req, res, upstream, null, headers);
      return;
    }

    collect(raw => {
      let payload = raw;
      const contentType = String(req.headers['content-type'] || '');
      const encoding = String(req.headers['content-encoding'] || '');
      let decoded = raw;
      if (encoding && raw.length) {
        const inflated = decodeBody(raw, encoding);
        if (!inflated) {
          stats.passthrough += 1;
          forward(req, res, upstream, payload, headers);
          return;
        }
        decoded = inflated;
      }

      if (decoded.length && /json/i.test(contentType)) {
        try {
          const body = JSON.parse(decoded.toString('utf8'));
          const model = String(body.model || '');
          stats.lastModel = model;
          if (matchesTarget(model, config.targetModels)) {
            const result = injectJson(body, parsed.pathname);
            if (result.changed) {
              payload = Buffer.from(JSON.stringify(body), 'utf8');
              stats.injected += 1;
              stats.lastInjectedAt = Date.now();
              stats.lastActions = result.actions;
              delete headers['content-encoding'];
              headers['content-length'] = String(payload.length);
            } else {
              stats.passthrough += 1;
            }
          } else {
            stats.passthrough += 1;
          }
        } catch {
          stats.passthrough += 1;
        }
      } else {
        stats.passthrough += 1;
      }

      if (payload !== raw && encoding) {
        // 已解压并可能改写，不能继续声明原始压缩头。
        delete headers['content-encoding'];
      }
      if (payload && payload.length) headers['content-length'] = String(payload.length);
      forward(req, res, upstream, payload, headers);
    });
  }

  function stop() {
    return new Promise(resolve => {
      if (!server) { listeningPort = 0; resolve(status()); return; }
      const closing = server;
      server = null;
      listeningPort = 0;
      try { if (typeof closing.closeAllConnections === 'function') closing.closeAllConnections(); } catch {}
      closing.close(() => resolve(status()));
      setTimeout(() => resolve(status()), 1500).unref?.();
    });
  }

  function start(next = {}) {
    if (startPromise) return startPromise;
    const requestedPort = next.port === undefined || next.port === null || next.port === ''
      ? config.port : Number(next.port);
    const requestedBase = next.upstreamBaseUrl === undefined ? config.upstreamBaseUrl : next.upstreamBaseUrl;
    let base = '';
    try { base = normalizeBase(requestedBase); }
    catch (error) {
      return Promise.reject(new Error(`upstreamBaseUrl 无效：${error.message}`));
    }

    const sameBase = base === config.upstreamBaseUrl;
    if (server && server.listening && sameBase && (!Number.isFinite(requestedPort) || requestedPort === listeningPort)) {
      return Promise.resolve(status());
    }

    const exactPort = next.exactPort === undefined ? !allowPortShift : next.exactPort !== false;
    startPromise = stop().then(() => new Promise((resolve, reject) => {
      config.upstreamBaseUrl = base;
      config.port = Number.isFinite(requestedPort) ? requestedPort : 8787;
      const candidates = config.port === 0
        ? [0]
        : exactPort
          ? [config.port]
          : Array.from({ length: 10 }, (_, index) => config.port + index);
      let index = 0;
      let settled = false;
      const fail = error => {
        if (settled) return;
        settled = true;
        startPromise = null;
        reject(error);
      };
      const attempt = () => {
        const candidate = candidates[index];
        const instance = http.createServer(handle);
        instance.once('error', error => {
          try { instance.close(); } catch {}
          if (error && error.code === 'EADDRINUSE' && !exactPort && index < candidates.length - 1) {
            index += 1;
            attempt();
            return;
          }
          fail(new Error(error && error.code === 'EADDRINUSE'
            ? (exactPort
              ? `端口 ${config.port} 已被占用；为避免固定 Base URL 指向错误端口，不会自动顺延。请关闭占用进程或修改 listenPort。`
              : `端口 ${candidates[0]}–${candidates[candidates.length - 1]} 均被占用`)
            : `本地代理启动失败：${error.message}`));
        });
        instance.listen(candidate, config.host, () => {
          if (settled) { try { instance.close(); } catch {} return; }
          settled = true;
          server = instance;
          listeningPort = instance.address().port;
          startPromise = null;
          resolve(status());
        });
      };
      attempt();
    })).catch(error => {
      startPromise = null;
      throw error;
    });
    return startPromise;
  }

  function update(patch = {}) {
    for (const key of ['targetModels', 'mode', 'seedMode', 'seedLanguage', 'toolStepAnchor', 'injectOnCompaction']) {
      if (patch[key] !== undefined) config[key] = patch[key];
    }
  }

  return { config, stats, status, start, stop, update, saveConfig };
}

module.exports = { createWeneedProxy, joinUpstream, normalizeBase, defaultConfigPath, configPage };