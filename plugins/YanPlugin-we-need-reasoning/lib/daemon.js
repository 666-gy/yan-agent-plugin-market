'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createWeneedProxy, defaultConfigPath } = require('./proxy');
const { writeState, removeState } = require('./daemon-control');

const VERSION = '1.0.1';
const statePath = String(process.env.WENEED_STATE_PATH || '').trim()
  ? path.resolve(String(process.env.WENEED_STATE_PATH))
  : path.join(os.homedir(), '.weneed-reasoning', 'daemon.json');
const configPath = process.env.WENEED_CONFIG_PATH === undefined
  ? defaultConfigPath()
  : String(process.env.WENEED_CONFIG_PATH || '');
const token = crypto.randomBytes(32).toString('hex');
const startedAt = Date.now();
const portValue = process.env.WENEED_LISTEN_PORT;
const numericPort = portValue === undefined || portValue === '' ? 8787 : Number(portValue);
const port = Number.isInteger(numericPort) && numericPort >= 0 && numericPort <= 65535 ? numericPort : 8787;
let shuttingDown = false;

function writeDaemonState(value) {
  const previous = process.env.WENEED_STATE_PATH;
  process.env.WENEED_STATE_PATH = statePath;
  try { writeState(value); } finally {
    if (previous === undefined) delete process.env.WENEED_STATE_PATH;
    else process.env.WENEED_STATE_PATH = previous;
  }
}

function clearDaemonState() {
  const previous = process.env.WENEED_STATE_PATH;
  process.env.WENEED_STATE_PATH = statePath;
  try { removeState(); } finally {
    if (previous === undefined) delete process.env.WENEED_STATE_PATH;
    else process.env.WENEED_STATE_PATH = previous;
  }
}

const proxy = createWeneedProxy({
  upstreamBaseUrl: String(process.env.WENEED_UPSTREAM_BASE_URL || ''),
  port,
  targetModels: String(process.env.WENEED_TARGET_MODELS || 'deepseek,flash;weneed,ds41'),
  mode: String(process.env.WENEED_MODE || 'standard'),
  seedMode: String(process.env.WENEED_SEED_MODE || 'upstream'),
  seedLanguage: String(process.env.WENEED_SEED_LANGUAGE || 'en'),
  configPath,
  version: VERSION,
  controlToken: token,
  onStopRequested: shutdown
});

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  proxy.stop().finally(() => {
    clearDaemonState();
    process.exit(0);
  });
}

function fail(error) {
  writeDaemonState({
    status: 'error',
    error: String(error && error.message || error),
    at: Date.now(),
    pid: process.pid,
    port
  });
  process.exit(1);
}

proxy.start({ port, exactPort: true }).then(state => {
  writeDaemonState({
    status: 'running',
    pid: process.pid,
    port: state.port,
    token,
    startedAt,
    version: VERSION,
    configPath,
    upstreamBaseUrl: state.upstreamBaseUrl
  });
}).catch(fail);

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);