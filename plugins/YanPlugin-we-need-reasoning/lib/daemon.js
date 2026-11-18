'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createWeneedProxy, defaultConfigPath } = require('./proxy');
const { writeState, removeState } = require('./daemon-control');

const VERSION = '1.0.1';
function argValue(name) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find(value => value.startsWith(prefix));
  return found === undefined ? undefined : found.slice(prefix.length);
}
function pickArg(name, envName, fallback) {
  const argument = argValue(name);
  if (argument !== undefined) return argument;
  const value = process.env[envName];
  return value === undefined ? fallback : String(value);
}
const stateArg = argValue('state-path');
const statePath = stateArg
  ? path.resolve(stateArg)
  : (String(process.env.WENEED_STATE_PATH || '').trim()
    ? path.resolve(String(process.env.WENEED_STATE_PATH))
    : path.join(os.homedir(), '.weneed-reasoning', 'daemon.json'));
const configArg = argValue('config-path');
const configPath = configArg !== undefined
  ? configArg
  : (process.env.WENEED_CONFIG_PATH === undefined ? defaultConfigPath() : String(process.env.WENEED_CONFIG_PATH || ''));
const token = crypto.randomBytes(32).toString('hex');
const startedAt = Date.now();
const portValue = pickArg('port', 'WENEED_LISTEN_PORT', '8787');
const numericPort = portValue === '' ? 8787 : Number(portValue);
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
  upstreamBaseUrl: pickArg('upstream-base-url', 'WENEED_UPSTREAM_BASE_URL', ''),
  port,
  targetModels: pickArg('target-models', 'WENEED_TARGET_MODELS', 'deepseek,flash;weneed,ds41') || 'deepseek,flash;weneed,ds41',
  mode: pickArg('mode', 'WENEED_MODE', 'standard') || 'standard',
  seedMode: pickArg('seed-mode', 'WENEED_SEED_MODE', 'upstream') || 'upstream',
  seedLanguage: pickArg('seed-language', 'WENEED_SEED_LANGUAGE', 'en') || 'en',
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