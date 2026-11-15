'use strict';

// Wallpaper Engine -> Yan Agent wallpaper bridge.
// Zero-dependency local MCP server (stdio, newline-delimited JSON-RPC 2.0).
//
// Integration contract (verified against Yan Agent source):
// - Custom wallpapers live in config.json `wallpaper.custom` (max 48 entries,
//   {id<=96, path<=1024, name<=120}); files must be inside YanData/uploads.
// - Supported media: JPG/PNG images, MP4/WebM videos, each <= 50 MB.
// - The renderer reloads config when the settings page opens, so an imported
//   wallpaper applies after opening settings or restarting the app.
// - Wallpaper audio is always muted by Yan; imported videos are stripped of
//   audio when transcoded.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const VERSION = '1.7.3';
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_CUSTOM = 48;
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png']);
const VIDEO_EXTS = new Set(['.mp4', '.webm']);
const VIDEO_ANY_EXTS = new Set(['.mp4', '.webm', '.m4v', '.mov', '.ogv']);
const ENTRY_PREFIX = 'custom-we-';
// Wallpaper-safe video policy: Yan renders wallpapers in a transparent Electron
// window, so 4K/60fps/high-level clips decode poorly (black frame or stutter)
// and HEVC/10-bit clips do not decode at all on many machines. Normalize to
// H.264 High / yuv420p / <=1920px / <=60fps / no audio.
const MAX_VIDEO_WIDTH = 1920;
const MAX_VIDEO_HEIGHT = 1920;
const MAX_VIDEO_FPS = 60;
const MAX_VIDEO_BITRATE = 24 * 1024 * 1024;
const POSTER_SUFFIX = '.poster.jpg';
// One ffmpeg attempt may need minutes for a long 4K clip; the whole prepare
// step is capped below the MCP call timeout (120s) so the tool always answers.
const FFMPEG_TIMEOUT_MS = 100000;
const FFMPEG_TOTAL_MS = 105000;

// ---------------------------------------------------------------------------
// Environment discovery
// ---------------------------------------------------------------------------

function parseLibraryFolders(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const out = [];
    const re = /"path"\s*"([^"]+)"/gi;
    let m;
    while ((m = re.exec(text))) out.push(m[1].replace(/\\\\/g, '\\'));
    return out;
  } catch {
    return [];
  }
}

function detectSteamLibraries() {
  const seeds = new Set();
  const override = String(process.env.WE_BRIDGE_STEAM_LIBRARY || '').trim();
  if (override) seeds.add(path.resolve(override));
  try {
    const r = spawnSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], {
      encoding: 'utf8', windowsHide: true, timeout: 5000
    });
    const m = String(r.stdout || '').match(/SteamPath\s+REG_SZ\s+(.+)/i);
    if (m) seeds.add(path.resolve(m[1].trim()));
  } catch { /* registry unavailable */ }
  for (const drive of ['C', 'D', 'E', 'F', 'G']) {
    for (const name of ['Steam', 'SteamLibrary', 'Program Files (x86)\\Steam', 'Program Files\\Steam', 'Games\\Steam']) {
      seeds.add(`${drive}:\\${name}`);
    }
  }
  const libraries = new Map();
  const addLib = p => {
    const resolved = path.resolve(p);
    const key = resolved.toLowerCase();
    if (!libraries.has(key)) libraries.set(key, resolved);
  };
  for (const seed of seeds) {
    let stat;
    try { stat = fs.statSync(seed); } catch { continue; }
    if (!stat.isDirectory()) continue;
    addLib(seed);
    for (const vdf of [
      path.join(seed, 'steamapps', 'libraryfolders.vdf'),
      path.join(seed, 'config', 'libraryfolders.vdf')
    ]) {
      for (const p of parseLibraryFolders(vdf)) {
        try { if (fs.statSync(p).isDirectory()) addLib(p); } catch { /* skip */ }
      }
    }
  }
  return [...libraries.values()];
}

function discover() {
  const libraries = detectSteamLibraries();
  const installs = [];
  const workshopDirs = [];
  for (const lib of libraries) {
    const we = path.join(lib, 'steamapps', 'common', 'wallpaper_engine');
    try {
      if (fs.existsSync(path.join(we, 'wallpaper64.exe')) || fs.existsSync(path.join(we, 'wallpaper32.exe'))) {
        installs.push(we);
      }
    } catch { /* skip */ }
    const ws = path.join(lib, 'steamapps', 'workshop', 'content', '431960');
    try { if (fs.statSync(ws).isDirectory()) workshopDirs.push(ws); } catch { /* skip */ }
  }
  const projectDirs = [];
  for (const we of installs) {
    const my = path.join(we, 'projects', 'myprojects');
    try { if (fs.statSync(my).isDirectory()) projectDirs.push(my); } catch { /* skip */ }
  }
  return { libraries, installs, workshopDirs, projectDirs };
}

function yanDataDir() {
  const override = String(process.env.WE_BRIDGE_YAN_DATA || '').trim();
  if (override) return path.resolve(override);
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'yan-agent', 'YanData');
}

let ffmpegCache;
function existingFile(candidate) {
  if (!candidate) return '';
  try {
    const st = fs.statSync(candidate);
    return st.isFile() ? candidate : '';
  } catch {
    return '';
  }
}

function findOnPath(bin) {
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], {
      encoding: 'utf8', windowsHide: true, timeout: 5000
    });
    for (const line of String(r.stdout || '').split(/\r?\n/)) {
      const found = existingFile(line.trim());
      if (found) return found;
    }
  } catch { /* not found */ }
  return '';
}

function findInTree(root, fileName, maxDepth) {
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return ''; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return full;
    if (maxDepth > 0 && entry.isDirectory()) {
      const nested = findInTree(full, fileName, maxDepth - 1);
      if (nested) return nested;
    }
  }
  return '';
}

function ffmpegCandidates() {
  if (process.env.WE_BRIDGE_NO_FFMPEG === '1') return [];
  const bin = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const out = [];
  const explicit = String(process.env.WE_BRIDGE_FFMPEG || '').trim();
  if (explicit) out.push(path.resolve(explicit));
  out.push(path.join(__dirname, bin));
  const onPath = findOnPath(process.platform === 'win32' ? 'ffmpeg' : 'ffmpeg');
  if (onPath) out.push(onPath);
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    // winget installs into a versioned package folder; scan it (bounded).
    const winget = path.join(local, 'Microsoft', 'WinGet', 'Packages');
    const fromWinget = findInTree(winget, bin, 3);
    if (fromWinget) out.push(fromWinget);
    for (const candidate of [
      path.join(os.homedir(), 'scoop', 'shims', 'ffmpeg.exe'),
      path.join(process.env.ProgramData || 'C:\\ProgramData', 'chocolatey', 'bin', 'ffmpeg.exe'),
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ffmpeg', 'bin', 'ffmpeg.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'ffmpeg', 'bin', 'ffmpeg.exe')
    ]) out.push(candidate);
  }
  return [...new Set(out)];
}

function findFfmpeg() {
  if (ffmpegCache !== undefined) return ffmpegCache;
  ffmpegCache = '';
  for (const candidate of ffmpegCandidates()) {
    const found = existingFile(candidate);
    if (found) { ffmpegCache = found; break; }
  }
  return ffmpegCache;
}

let ffmpegVersionCache;
function ffmpegVersion() {
  if (ffmpegVersionCache !== undefined) return ffmpegVersionCache;
  ffmpegVersionCache = '';
  const ff = findFfmpeg();
  if (!ff) return ffmpegVersionCache;
  try {
    const r = spawnSync(ff, ['-version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    ffmpegVersionCache = String(r.stdout || '').split(/\r?\n/)[0].trim();
  } catch { /* version is informational */ }
  return ffmpegVersionCache;
}

// ---------------------------------------------------------------------------
// Wallpaper Engine project scanning
// ---------------------------------------------------------------------------

function readProject(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  } catch {
    return null;
  }
}

function sanitizeName(value, fallback) {
  const cleaned = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
  return cleaned || fallback;
}

function statSafe(file) {
  try {
    const s = fs.statSync(file);
    return s.isFile() ? s : null;
  } catch {
    return null;
  }
}

function resolveMedia(dir, proj) {
  const type = String(proj.type || '').toLowerCase();
  const previewRel = String(proj.preview || '');
  const previewPath = previewRel ? path.join(dir, previewRel) : '';
  const previewStat = previewPath ? statSafe(previewPath) : null;
  if (type === 'video') {
    const fileRel = String(proj.file || '');
    const filePath = fileRel ? path.join(dir, fileRel) : '';
    const st = filePath ? statSafe(filePath) : null;
    if (st) {
      const ext = path.extname(filePath).toLowerCase();
      return {
        kind: VIDEO_EXTS.has(ext) ? 'video' : 'video-other',
        path: filePath, bytes: st.size,
        previewPath: previewStat ? previewPath : '', previewBytes: previewStat ? previewStat.size : 0
      };
    }
  }
  if (previewStat) {
    const ext = path.extname(previewPath).toLowerCase();
    const kind = IMAGE_EXTS.has(ext) ? 'image' : ext === '.gif' ? 'gif' : 'preview-other';
    return { kind, path: previewPath, bytes: previewStat.size, previewPath, previewBytes: previewStat.size };
  }
  return { kind: 'none', path: '', bytes: 0, previewPath: '', previewBytes: 0 };
}

function describeProject(dir, id, proj, source) {
  const type = String(proj.type || 'unknown').toLowerCase();
  const media = resolveMedia(dir, proj);
  let importable = true;
  let note = '';
  if (type === 'video' && (media.kind === 'video' || media.kind === 'video-other')) {
    note = media.bytes > MAX_BYTES
      ? '视频超过 50MB，导入时自动压缩为 1080p 安全规格'
      : '视频壁纸，导入时自动转为 1080p/无音轨安全规格';
    if (media.kind === 'video-other') note += '（需 ffmpeg 转码）';
    if (media.bytes > MAX_BYTES && !findFfmpeg()) { importable = false; note = '视频超过 50MB 且未找到 ffmpeg，无法导入；可先用预览图模式'; }
  } else if (media.kind === 'image') {
    note = type === 'video' ? '视频文件缺失，导入静态图' : '场景/网页类：导入时自动提取高清原图（静态，可达 4K）';
  } else if (media.kind === 'gif') {
    note = '场景/网页类：优先提取高清原图，无原图时 GIF 转 MP4';
    if (!findFfmpeg()) { note = '场景类：优先提取高清原图（GIF 转 MP4 需 ffmpeg）'; }
  } else {
    importable = false;
    note = '未找到可用的媒体文件或预览图';
  }
  return {
    id, source,
    title: sanitizeName(proj.title, path.basename(dir)),
    type,
    tags: Array.isArray(proj.tags) ? proj.tags.map(String).slice(0, 12) : [],
    directory: dir,
    mediaKind: media.kind,
    mediaPath: media.path,
    mediaBytes: media.bytes,
    previewPath: media.previewPath,
    importable, note
  };
}

function scanWallpapers() {
  const d = discover();
  const items = [];
  for (const ws of d.workshopDirs) {
    let entries = [];
    try { entries = fs.readdirSync(ws); } catch { continue; }
    for (const id of entries) {
      if (!/^\d+$/.test(id)) continue;
      const dir = path.join(ws, id);
      const proj = readProject(dir);
      if (proj) items.push(describeProject(dir, id, proj, 'workshop'));
    }
  }
  for (const root of d.projectDirs) {
    let entries = [];
    try { entries = fs.readdirSync(root); } catch { continue; }
    for (const name of entries) {
      const dir = path.join(root, name);
      try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
      const proj = readProject(dir);
      if (proj) items.push(describeProject(dir, `local-${name}`, proj, 'local'));
    }
  }
  items.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
  return { discovery: d, items };
}

function findItem(id) {
  const { items } = scanWallpapers();
  const wanted = String(id || '').trim();
  return items.find(item => item.id === wanted) || null;
}

// ---------------------------------------------------------------------------
// Yan config access (read-modify-write, atomic, wallpaper section only)
// ---------------------------------------------------------------------------

function readYanConfig() {
  const file = path.join(yanDataDir(), 'config.json');
  const raw = fs.readFileSync(file, 'utf8');
  return { file, raw, cfg: JSON.parse(raw) };
}

function updateYanConfig(mutate) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { file, raw, cfg } = readYanConfig();
    const before = fs.statSync(file).mtimeMs;
    const next = mutate(cfg);
    const compact = !raw.includes('\n');
    const text = compact ? JSON.stringify(next) : JSON.stringify(next, null, 2);
    try { fs.copyFileSync(file, `${file}.we-bridge.bak`); } catch { /* backup is best-effort */ }
    const tmp = `${file}.we-bridge-${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    try {
      if (fs.statSync(file).mtimeMs !== before) continue; // concurrent write: retry
      fs.renameSync(tmp, file);
      return next;
    } finally {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }
  throw new Error('Yan 配置文件正被其他操作修改，请稍后重试（导入期间请避免同时在设置页保存设置）。');
}

function wallpaperSection(cfg) {
  const w = cfg.wallpaper && typeof cfg.wallpaper === 'object' ? cfg.wallpaper : {};
  if (!Array.isArray(w.custom)) w.custom = [];
  return w;
}

// ---------------------------------------------------------------------------
// High-resolution scene asset extraction
// ---------------------------------------------------------------------------
// WE scene/web wallpapers render from assets packed in scene.pkg (or loose
// files for web projects). The workshop preview.jpg/gif is only a small
// thumbnail; the real background is usually the largest embedded JPEG/PNG.
// We extract that at import time for full quality instead of the thumbnail.

function imageDimensions(buf, ext) {
  if (ext === '.png') {
    if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504E47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    return null;
  }
  // JPEG: scan SOF markers
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

function findEmbeddedImages(buf) {
  const found = [];
  for (let i = 0; i < buf.length - 8; i++) {
    if (buf[i] === 0xFF && buf[i + 1] === 0xD8 && buf[i + 2] === 0xFF) {
      let end = i + 2;
      while (end < buf.length - 1) {
        if (buf[end] === 0xFF && buf[end + 1] === 0xD9) { end += 2; break; }
        end++;
      }
      found.push({ ext: '.jpg', offset: i, size: end - i });
      i = end;
    } else if (buf[i] === 0x89 && buf[i + 1] === 0x50 && buf[i + 2] === 0x4E && buf[i + 3] === 0x47) {
      let end = i + 8;
      while (end < buf.length - 8) {
        if (buf[end] === 0x49 && buf[end + 1] === 0x45 && buf[end + 2] === 0x4E && buf[end + 3] === 0x44) { end += 12; break; }
        end++;
      }
      found.push({ ext: '.png', offset: i, size: end - i });
      i = end;
    }
  }
  return found;
}

function findFfprobe() {
  const ff = findFfmpeg();
  if (ff) {
    const probe = path.join(path.dirname(ff), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    if (existingFile(probe)) return probe;
  }
  return findOnPath('ffprobe');
}

function probeDims(file) {
  const probe = findFfprobe();
  if (!probe) return null;
  const r = spawnSync(probe, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'json', file],
    { encoding: 'utf8', timeout: 10000, windowsHide: true });
  try {
    const s = JSON.parse(r.stdout).streams?.[0];
    return s && s.width && s.height ? { width: s.width, height: s.height } : null;
  } catch { return null; }
}

function saneHeaderDim(buf, ext, size) {
  const d = imageDimensions(buf, ext);
  if (!d || d.width < 256 || d.height < 256 || d.width > 16384 || d.height > 16384) return null;
  const bpp = size / (d.width * d.height);
  const min = ext === '.png' ? 0.02 : 0.01;
  if (bpp < min || bpp > 10) return null;
  return d;
}

function pickBestImage(candidates, readBuf) {
  const top = candidates.sort((a, b) => b.size - a.size).slice(0, 12);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'we-img-'));
  const verified = [];
  try {
    let n = 0;
    for (const c of top) {
      const data = readBuf(c);
      if (!data || data.length < 1000) continue;
      let dim = null;
      const tmp = path.join(tmpDir, `c${n++}${c.ext}`);
      try {
        fs.writeFileSync(tmp, data);
        dim = probeDims(tmp); // authoritative: actually decode the header
      } catch { /* ignore */ }
      if (!dim) dim = saneHeaderDim(data, c.ext, data.length); // fallback when no ffprobe
      if (dim && dim.width >= 256 && dim.height >= 256 && dim.width <= 16384 && dim.height <= 16384) {
        verified.push({ ...c, data, width: dim.width, height: dim.height });
      }
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  if (!verified.length) return null;
  verified.sort((a, b) => (b.width * b.height) - (a.width * a.height) || b.size - a.size);
  return verified[0];
}

function extractBestSceneImage(dir, type) {
  if (type === 'web') {
    // loose image files in the project directory
    const candidates = [];
    const walk = (d, depth) => {
      if (depth > 3) return;
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else {
          const ext = path.extname(e.name).toLowerCase();
          if (IMAGE_EXTS.has(ext)) {
            const st = statSafe(full);
            if (st) candidates.push({ ext: ext === '.jpeg' ? '.jpg' : ext, file: full, size: st.size });
          }
        }
      }
    };
    walk(dir, 0);
    return pickBestImage(candidates, c => { try { return fs.readFileSync(c.file); } catch { return null; } });
  }
  // scene (and others): embedded images in scene.pkg
  const pkg = path.join(dir, 'scene.pkg');
  const st = statSafe(pkg);
  if (!st) return null;
  const buf = fs.readFileSync(pkg);
  const candidates = findEmbeddedImages(buf);
  return pickBestImage(candidates, c => buf.slice(c.offset, c.offset + c.size));
}

// ---------------------------------------------------------------------------
// Media preparation (copy / transcode) into YanData/uploads
// ---------------------------------------------------------------------------

function runFfmpeg(args, options = {}) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return Promise.reject(new Error('未找到 ffmpeg，无法转码。请安装 ffmpeg 或改用静态预览图模式。'));
  const deadline = Number(options.deadline) || (Date.now() + FFMPEG_TOTAL_MS);
  const budget = Math.min(Number(options.timeout) || FFMPEG_TIMEOUT_MS, deadline - Date.now());
  if (budget <= 1000) {
    return Promise.reject(new Error('视频处理总时长超时。请改用 mode="preview" 导入静态预览图，或先在 Wallpaper Engine 中换一个更短的视频。'));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error(`ffmpeg 处理超时（>${Math.round(budget / 1000)}s）。可改用 mode="preview" 导入静态预览。`));
    }, budget);
    child.stderr.on('data', chunk => { stderr += String(chunk); if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 退出码 ${code}：${stderr.slice(-600)}`));
    });
  });
}

function parseFps(value) {
  const text = String(value || '').trim();
  if (!text || text === '0/0') return 0;
  const [num, den] = text.split('/').map(Number);
  if (Number.isFinite(num) && Number.isFinite(den) && den > 0) return num / den;
  const direct = Number(text);
  return Number.isFinite(direct) ? direct : 0;
}

// Returns null when ffprobe is unavailable or the file is not a readable video.
function probeVideo(file) {
  const probe = findFfprobe();
  if (!probe) return null;
  const r = spawnSync(probe, ['-v', 'error',
    '-show_entries', 'stream=codec_type,codec_name,profile,width,height,pix_fmt,r_frame_rate,avg_frame_rate,level,bit_rate,duration',
    '-show_entries', 'format=duration,bit_rate',
    '-of', 'json', file],
    { encoding: 'utf8', timeout: 20000, windowsHide: true });
  try {
    const json = JSON.parse(r.stdout);
    const streams = Array.isArray(json.streams) ? json.streams : [];
    const stream = streams.find(s => s.codec_type === 'video') || null;
    const format = json.format || {};
    const duration = Number(stream?.duration || format.duration || 0) || 0;
    if (!stream || !stream.codec_name) return { hasVideo: false, duration };
    return {
      hasVideo: true,
      codec: String(stream.codec_name || ''),
      profile: String(stream.profile || ''),
      pix: String(stream.pix_fmt || ''),
      width: Number(stream.width) || 0,
      height: Number(stream.height) || 0,
      fps: parseFps(stream.avg_frame_rate) || parseFps(stream.r_frame_rate),
      level: Number(stream.level) || 0,
      bitrate: Number(stream.bit_rate || format.bit_rate) || 0,
      duration
    };
  } catch { return null; }
}

// Chromium/Electron decodes H.264 High 8-bit reliably. HEVC / 10-bit / 4:2:2
// either fail outright or fall back to software decode and stutter, and 4K
// clips are far beyond what a wallpaper window needs. Anything outside this
// envelope is re-encoded once at import time.
function isSafeVideo(info) {
  if (!info || !info.hasVideo) return false;
  if (info.codec !== 'h264') return false;
  if (String(info.pix || '').toLowerCase() !== 'yuv420p') return false;
  if (!info.width || !info.height) return false;
  if (info.width > MAX_VIDEO_WIDTH || info.height > MAX_VIDEO_HEIGHT) return false;
  if (info.fps && info.fps > MAX_VIDEO_FPS + 0.5) return false;
  if (info.bitrate && info.bitrate > MAX_VIDEO_BITRATE) return false;
  return true;
}

function encodeArgs(source, target, info, options) {
  const filters = [];
  if (info?.fps && info.fps > MAX_VIDEO_FPS + 0.5) filters.push(`fps=${MAX_VIDEO_FPS}`);
  // Fit the whole frame inside a width x width box, preserving aspect ratio and
  // even dimensions. This also caps the longest edge of portrait / ultrawide clips.
  filters.push(`scale=w='min(${options.width},iw)':h='min(${options.width},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`);
  const args = [
    '-y', '-i', source,
    '-map', '0:v:0',
    '-vf', filters.join(','),
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high',
    '-pix_fmt', 'yuv420p', '-map_metadata', '-1', '-an'
  ];
  if (options.bitrate) {
    args.push('-b:v', String(options.bitrate),
      '-maxrate', String(Math.round(options.bitrate * 1.25)),
      '-bufsize', String(options.bitrate * 2));
  } else {
    args.push('-crf', String(options.crf || 23));
  }
  args.push('-movflags', '+faststart', target);
  return args;
}

async function normalizeVideo(source, target, info, deadline) {
  const attempts = [{ width: MAX_VIDEO_WIDTH, crf: 23 }];
  const duration = Number(info?.duration) || 0;
  if (duration > 0) {
    // Long clips at CRF 23 can exceed 50 MB; target a bitrate that fits in one
    // extra pass instead of shrinking repeatedly.
    const budgetBits = 45 * 1024 * 1024 * 8;
    const bitrate = Math.max(320000, Math.floor(budgetBits / duration / 1000) * 1000);
    attempts.push({ width: MAX_VIDEO_WIDTH, bitrate });
  }
  attempts.push({ width: 1280, crf: 28 }, { width: 960, crf: 30 });
  let lastError = null;
  for (const attempt of attempts) {
    try {
      await runFfmpeg(encodeArgs(source, target, info, attempt), { deadline });
      const st = statSafe(target);
      if (st && st.size > 0 && st.size <= MAX_BYTES) return st.size;
      if (st && st.size > MAX_BYTES) lastError = new Error('转码后仍超过 50MB');
    } catch (error) {
      lastError = error;
      if (/总时长超时/.test(String(error?.message || ''))) break;
    }
  }
  throw new Error(`视频转码失败：${String(lastError?.message || '输出文件无效或超过 50MB')}`);
}

async function remuxVideo(source, target, deadline) {
  // Stream copy: strips audio/metadata and moves the index to the front so the
  // first frame appears immediately. Falls back to a plain copy on failure.
  try {
    await runFfmpeg(['-y', '-i', source, '-map', '0:v:0', '-c:v', 'copy', '-an',
      '-map_metadata', '-1', '-movflags', '+faststart', target], { deadline, timeout: 120000 });
    const st = statSafe(target);
    if (st && st.size > 0) return st.size;
  } catch { /* fall through to copy */ }
  try { fs.unlinkSync(target); } catch { /* ignore */ }
  fs.copyFileSync(source, target);
  return statSafe(target)?.size || 0;
}

function posterPathFor(target) {
  return String(target).replace(/\.(?:mp4|webm|m4v|mov|ogv)$/i, POSTER_SUFFIX);
}

async function makePoster(source, posterPath, info, deadline) {
  const duration = Number(info?.duration) || 0;
  const seek = duration > 3 ? Math.min(2, duration / 3) : 0.2;
  try {
    await runFfmpeg([
      '-y', '-ss', String(seek.toFixed(2)), '-i', source,
      '-frames:v', '1', '-vf', "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
      '-q:v', '3', '-an', posterPath
    ], { deadline, timeout: 60000 });
    const st = statSafe(posterPath);
    if (st && st.size > 500) return true;
  } catch { /* best-effort */ }
  try { fs.unlinkSync(posterPath); } catch { /* ignore */ }
  return false;
}

function copyPreviewPoster(item, posterPath) {
  const preview = String(item?.previewPath || '');
  const ext = path.extname(preview).toLowerCase();
  if (!preview || !['.jpg', '.jpeg', '.png'].includes(ext)) return false;
  try {
    fs.copyFileSync(preview, posterPath);
    return (statSafe(posterPath)?.size || 0) > 500;
  } catch {
    return false;
  }
}

function gifFrameToPng(source, target) {
  // Last-resort static fallback without ffmpeg: System.Drawing decodes the
  // first GIF frame to PNG. Windows PowerShell ships with .NET Framework.
  if (process.platform !== 'win32') return false;
  const script = [
    'Add-Type -AssemblyName System.Drawing',
    '$img=[System.Drawing.Image]::FromFile($env:WE_GIF_SRC)',
    'try { $img.Save($env:WE_GIF_DST,[System.Drawing.Imaging.ImageFormat]::Png) } finally { $img.Dispose() }'
  ].join('; ');
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, WE_GIF_SRC: source, WE_GIF_DST: target },
      encoding: 'utf8', timeout: 30000, windowsHide: true
    });
    return r.status === 0 && (statSafe(target)?.size || 0) > 500;
  } catch {
    return false;
  }
}

async function attachPoster(item, target, info, deadline) {
  const poster = posterPathFor(target);
  let ok = false;
  if (findFfmpeg()) {
    try { ok = await makePoster(target, poster, info, deadline); } catch { /* ignore */ }
  }
  if (!ok) ok = copyPreviewPoster(item, poster);
  if (!ok) { try { fs.unlinkSync(poster); } catch { /* ignore */ } }
  return ok ? poster : '';
}

async function gifToMp4(source, target, deadline) {
  const bytes = await normalizeVideo(source, target, null, deadline);
  return bytes;
}

function imageSizeOf(file) {
  const st = statSafe(file);
  if (!st || st.size > 20 * 1024 * 1024) return null;
  try {
    return imageDimensions(fs.readFileSync(file), path.extname(file).toLowerCase());
  } catch {
    return null;
  }
}

function uploadsDir() {
  const dir = path.join(yanDataDir(), 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isInsideUploads(file) {
  const root = path.resolve(uploadsDir()).toLowerCase() + path.sep;
  return path.resolve(String(file || '')).toLowerCase().startsWith(root);
}

async function prepareStatic(item, stamp, safeId, deadline, options = {}) {
  const staticOnly = options.staticOnly === true;
  // Static path: prefer the full-resolution original asset over the thumbnail.
  let hires = null;
  try { hires = extractBestSceneImage(item.directory, item.type); } catch { /* fall back to preview */ }
  if (hires && Math.max(hires.width, hires.height) >= 1024 && (hires.data.length <= MAX_BYTES || findFfmpeg())) {
    let target, bytes;
    if (hires.data.length <= MAX_BYTES) {
      target = path.join(uploadsDir(), `${stamp}_we_${safeId}${hires.ext}`);
      fs.writeFileSync(target, hires.data);
      bytes = hires.data.length;
    } else {
      if (!findFfmpeg()) throw new Error('高清原图超过 50MB 且未找到 ffmpeg，无法转存。');
      const tmp = path.join(os.tmpdir(), `we-hires-${stamp}${hires.ext}`);
      fs.writeFileSync(tmp, hires.data);
      target = path.join(uploadsDir(), `${stamp}_we_${safeId}.jpg`);
      try {
        await runFfmpeg(['-y', '-i', tmp, '-q:v', '2', target], { deadline });
      } finally {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      }
      bytes = statSafe(target)?.size || 0;
      if (!bytes || bytes > MAX_BYTES) throw new Error('高清原图超过 50MB 且压缩后仍超限，无法导入。');
    }
    return { path: target, bytes, kind: 'image', dynamic: false, hires: true, width: hires.width, height: hires.height };
  }

  const preview = item.previewPath;
  if (!preview || !statSafe(preview)) throw new Error('该壁纸没有可用的预览图或可提取的高清原图。');
  const ext = path.extname(preview).toLowerCase();
  if (IMAGE_EXTS.has(ext)) {
    const st = statSafe(preview);
    if (st.size > MAX_BYTES) throw new Error('预览图超过 50MB，无法导入。');
    const target = path.join(uploadsDir(), `${stamp}_we_${safeId}${ext === '.jpeg' ? '.jpg' : ext}`);
    fs.copyFileSync(preview, target);
    const dims = imageSizeOf(target) || {};
    return { path: target, bytes: st.size, kind: 'image', dynamic: false, hires: false, width: dims.width, height: dims.height };
  }
  if (ext === '.gif') {
    if (staticOnly) {
      const png = path.join(uploadsDir(), `${stamp}_we_${safeId}.png`);
      if (gifFrameToPng(preview, png)) {
        const dims = imageSizeOf(png) || {};
        return {
          path: png, bytes: statSafe(png)?.size || 0, kind: 'image', dynamic: false,
          hires: false, gifFrame: true, width: dims.width, height: dims.height
        };
      }
      if (findFfmpeg()) {
        try {
          await runFfmpeg(['-y', '-ss', '0.2', '-i', preview, '-frames:v', '1',
            "scale=w='min(1920,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
            png], { deadline, timeout: 60000 });
          const dims = imageSizeOf(png) || {};
          return {
            path: png, bytes: statSafe(png)?.size || 0, kind: 'image', dynamic: false,
            hires: false, gifFrame: true, width: dims.width, height: dims.height
          };
        } catch { /* fall through */ }
      }
      throw new Error('预览图为 GIF，但无法提取静态首帧（需要 ffmpeg 或可用的 Windows PowerShell）。');
    }
    if (findFfmpeg()) {
      const target = path.join(uploadsDir(), `${stamp}_we_${safeId}.mp4`);
      const bytes = await gifToMp4(preview, target, deadline);
      const info = probeVideo(target);
      const posterPath = await attachPoster(item, target, info, deadline);
      return { path: target, bytes, kind: 'video', dynamic: true, hires: false, posterPath: posterPath || undefined };
    }
    // No ffmpeg: keep a static first frame instead of failing the import.
    const png = path.join(uploadsDir(), `${stamp}_we_${safeId}.png`);
    if (gifFrameToPng(preview, png)) {
      const dims = imageSizeOf(png) || {};
      return {
        path: png, bytes: statSafe(png)?.size || 0, kind: 'image', dynamic: false,
        hires: false, gifFrame: true, width: dims.width, height: dims.height
      };
    }
    throw new Error('预览图为 GIF，需要 ffmpeg（或可用的 Windows PowerShell）转换，但均不可用。');
  }
  throw new Error(`预览图格式 ${ext || '(无扩展名)'} 不受支持（仅 JPG/PNG/GIF）。`);
}

async function prepareMedia(item, mode, compress, options = {}) {
  const wantPreview = mode === 'preview';
  const wantVideo = mode === 'video';
  const fallbackStatic = options.fallbackStatic !== false;
  const isVideoSource = item.mediaKind === 'video' || item.mediaKind === 'video-other';
  const deadline = Date.now() + FFMPEG_TOTAL_MS;

  if (wantVideo && !isVideoSource) {
    throw new Error(`该壁纸类型为 ${item.type}，没有可导入的视频文件。请用 mode="preview" 或 mode="auto"。`);
  }

  const stamp = Date.now();
  const safeId = item.id.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 60);

  if (wantPreview || (!isVideoSource && !wantVideo)) {
    return prepareStatic(item, stamp, safeId, deadline, { staticOnly: wantPreview });
  }

  // Video path.
  const source = item.mediaPath;
  const st = statSafe(source);
  if (!st || st.size < 1024) {
    if (fallbackStatic) {
      const media = await prepareStatic(item, stamp, safeId, deadline);
      return { ...media, fallbackFromVideo: true, fallbackReason: '视频文件不存在、为空或已损坏' };
    }
    throw new Error('视频文件不存在、为空或已损坏。');
  }
  const ext = path.extname(source).toLowerCase();
  const info = probeVideo(source);
  const safe = isSafeVideo(info);
  const canTranscode = Boolean(findFfmpeg());

  const staticFallback = async reason => {
    if (!fallbackStatic) throw new Error(`${reason}；且未启用静态备用图。`);
    const media = await prepareStatic(item, stamp, safeId, deadline);
    return { ...media, fallbackFromVideo: true, fallbackReason: reason };
  };

  // Already within the safe envelope: strip audio/index and add a poster.
  if (safe && VIDEO_EXTS.has(ext) && st.size <= MAX_BYTES) {
    const targetExt = ext === '.webm' ? '.webm' : '.mp4';
    const target = path.join(uploadsDir(), `${stamp}_we_${safeId}${targetExt}`);
    let bytes;
    if (canTranscode && targetExt === '.mp4') bytes = await remuxVideo(source, target, deadline);
    else { fs.copyFileSync(source, target); bytes = st.size; }
    const posterPath = await attachPoster(item, target, info, deadline);
    return {
      path: target, bytes, kind: 'video', dynamic: true, alreadySafe: true,
      codec: info?.codec, width: info?.width, height: info?.height, fps: info?.fps,
      posterPath: posterPath || undefined
    };
  }

  // No ffprobe available: copy MP4/WebM as-is rather than failing every import.
  if (!info && VIDEO_EXTS.has(ext) && st.size <= MAX_BYTES) {
    const target = path.join(uploadsDir(), `${stamp}_we_${safeId}${ext}`);
    fs.copyFileSync(source, target);
    const posterPath = await attachPoster(item, target, null, deadline);
    return {
      path: target, bytes: st.size, kind: 'video', dynamic: true, unverified: true,
      posterPath: posterPath || undefined
    };
  }

  if (!compress) {
    const reason = st.size > MAX_BYTES
      ? `视频 ${Math.round(st.size / 1024 / 1024)}MB 超过 50MB 上限且未启用压缩`
      : '视频编码不在壁纸安全范围内且未启用转码';
    return staticFallback(reason);
  }
  if (!canTranscode) {
    return staticFallback('未找到 ffmpeg，无法转换/压缩视频');
  }

  const target = path.join(uploadsDir(), `${stamp}_we_${safeId}.mp4`);
  let bytes;
  try {
    bytes = await normalizeVideo(source, target, info, deadline);
  } catch (error) {
    try { if (fs.existsSync(target)) fs.unlinkSync(target); } catch { /* ignore */ }
    return staticFallback(`视频转换失败（${String(error?.message || error)}）`);
  }
  const posterPath = await attachPoster(item, target, info, deadline);
  const outInfo = probeVideo(target);
  return {
    path: target, bytes, kind: 'video', dynamic: true, transcoded: true,
    codecFixed: !safe,
    width: outInfo?.width,
    height: outInfo?.height,
    fps: outInfo?.fps ? Math.min(MAX_VIDEO_FPS, Math.round(outInfo.fps)) : undefined,
    posterPath: posterPath || undefined
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function toolStatus() {
  const d = discover();
  const dataDir = yanDataDir();
  const configFile = path.join(dataDir, 'config.json');
  let wallpaper = null;
  let configError = '';
  try {
    const { cfg } = readYanConfig();
    const w = wallpaperSection(cfg);
    wallpaper = {
      selectedId: String(w.id || ''),
      selectedName: String(w.name || ''),
      customCount: w.custom.length,
      weImportedCount: w.custom.filter(e => String(e.id || '').startsWith(ENTRY_PREFIX)).length
    };
  } catch (error) {
    configError = String(error.message || error);
  }
  let workshopCount = 0;
  let localCount = 0;
  try {
    const { items } = scanWallpapers();
    workshopCount = items.filter(i => i.source === 'workshop').length;
    localCount = items.filter(i => i.source === 'local').length;
  } catch { /* scan issues reported via counts */ }
  const ffmpeg = findFfmpeg();
  const ffprobe = findFfprobe();
  let importedVideos = null;
  try {
    const { cfg } = readYanConfig();
    const w = wallpaperSection(cfg);
    const entries = w.custom.filter(e => String(e.id || '').startsWith(ENTRY_PREFIX));
    const videos = entries.filter(e => VIDEO_ANY_EXTS.has(path.extname(String(e.path || '')).toLowerCase()));
    let totalBytes = 0;
    let posters = 0;
    for (const entry of videos) {
      totalBytes += statSafe(String(entry.path || ''))?.size || 0;
      if (statSafe(posterPathFor(String(entry.path || '')))) posters += 1;
    }
    importedVideos = {
      count: videos.length,
      totalMB: Math.round(totalBytes / 1048576 * 10) / 10,
      withPoster: posters
    };
  } catch { /* config issues reported above */ }
  return {
    ok: true,
    yanDataDir: dataDir,
    yanConfigFound: !configError,
    configError: configError || undefined,
    wallpaper,
    importedVideos,
    galleryPort: galleryPort(),
    steamLibraries: d.libraries,
    wallpaperEngineInstalls: d.installs,
    workshopDirs: d.workshopDirs,
    workshopWallpapers: workshopCount,
    localProjects: localCount,
    ffmpeg: ffmpeg
      ? { available: true, path: ffmpeg, ffprobe: ffprobe || '', version: ffmpegVersion() || undefined }
      : { available: false, ffprobe: ffprobe || '' },
    videoPolicy: {
      maxWidth: MAX_VIDEO_WIDTH,
      maxHeight: MAX_VIDEO_HEIGHT,
      maxFps: MAX_VIDEO_FPS,
      maxBitrateMbps: Math.round(MAX_VIDEO_BITRATE / 1048576),
      codec: 'h264 (8-bit yuv420p)',
      audio: 'removed',
      note: '所有视频在导入时统一转换为 H.264 / 8-bit / ≤1920px / ≤60fps / ≤24Mbps / 无音轨；过重或 HEVC 视频不会原样塞给 Yan，避免黑屏与卡顿。转换失败会自动改用静态备用图。'
    },
    limits: {
      maxFileBytes: MAX_BYTES,
      maxCustomEntries: MAX_CUSTOM,
      formats: ['jpg', 'png', 'mp4', 'webm'],
      note: '场景/网页类壁纸导入时自动从 scene.pkg/项目目录提取高清原图（静态，可达 4K）；无法提取时退回预览图。视频壁纸统一转为壁纸安全规格并生成静态备用图，超 50MB 自动压缩。'
    }
  };
}

function toolList(args = {}) {
  const query = String(args.query || '').trim().toLowerCase();
  const type = String(args.type || '').trim().toLowerCase();
  const limit = Math.min(Math.max(Number(args.limit) || 60, 1), 300);
  const { discovery, items } = scanWallpapers();
  if (!discovery.workshopDirs.length && !discovery.projectDirs.length) {
    return {
      ok: false,
      error: '未找到 Wallpaper Engine 创意工坊目录或本地项目。请确认已安装 Wallpaper Engine 并订阅壁纸，或在插件配置中填写 steamLibrary。',
      steamLibraries: discovery.libraries
    };
  }
  let filtered = items;
  if (type) filtered = filtered.filter(item => item.type === type);
  if (query) {
    filtered = filtered.filter(item =>
      item.title.toLowerCase().includes(query)
      || item.id.toLowerCase().includes(query)
      || item.tags.some(tag => tag.toLowerCase().includes(query)));
  }
  return {
    ok: true,
    total: filtered.length,
    shown: Math.min(filtered.length, limit),
    wallpapers: filtered.slice(0, limit).map(item => ({
      id: item.id, title: item.title, type: item.type, source: item.source,
      tags: item.tags,
      mediaKind: item.mediaKind,
      sizeMB: item.mediaBytes ? Math.round(item.mediaBytes / 1024 / 1024 * 10) / 10 : 0,
      previewPath: item.previewPath || undefined,
      importable: item.importable, note: item.note
    }))
  };
}

async function toolImport(args = {}) {
  const id = String(args.id || '').trim();
  if (!id) return { ok: false, error: '缺少壁纸 id。先用 we_list_wallpapers 获取。' };
  const mode = ['auto', 'video', 'preview'].includes(args.mode) ? args.mode : 'auto';
  const apply = args.apply !== false;
  const compress = args.compress !== false;
  const fallbackStatic = args.fallbackStatic !== false;
  const item = findItem(id);
  if (!item) return { ok: false, error: `未找到壁纸 ${id}。请用 we_list_wallpapers 核对 id。` };

  const dataDir = yanDataDir();
  if (!fs.existsSync(path.join(dataDir, 'config.json'))) {
    return { ok: false, error: `未找到 Yan 配置文件：${path.join(dataDir, 'config.json')}。请确认 Yan Agent 已运行过，或配置 yanDataDir。` };
  }

  let media;
  try {
    media = await prepareMedia(item, mode, compress, { fallbackStatic });
  } catch (error) {
    return { ok: false, error: String(error.message || error), wallpaper: { id: item.id, title: item.title, type: item.type } };
  }

  const entryId = `${ENTRY_PREFIX}${item.id.replace(/[^a-zA-Z0-9-]/g, '-')}`.slice(0, 96);
  const name = sanitizeName(args.name || item.title, item.title);
  let replaced = false;
  const cleanup = [];
  try {
    updateYanConfig(cfg => {
      const w = wallpaperSection(cfg);
      const index = w.custom.findIndex(entry => String(entry.id || '') === entryId);
      const entry = { id: entryId, path: media.path, name };
      if (index >= 0) {
        const oldPath = String(w.custom[index].path || '');
        w.custom[index] = entry;
        replaced = true;
        if (oldPath && oldPath !== media.path && isInsideUploads(oldPath)) {
          cleanup.push(oldPath, posterPathFor(oldPath));
        }
      } else {
        if (w.custom.length >= MAX_CUSTOM) {
          throw new Error(`Yan 壁纸库已满（${MAX_CUSTOM} 个）。请先用 we_remove_imported 或在设置页删除旧壁纸。`);
        }
        w.custom.push(entry);
      }
      if (apply) {
        w.id = entryId;
        w.path = media.path;
        w.name = name;
      }
      cfg.wallpaper = w;
      return cfg;
    });
  } catch (error) {
    try { fs.unlinkSync(media.path); } catch { /* ignore */ }
    if (media.posterPath) try { fs.unlinkSync(media.posterPath); } catch { /* ignore */ }
    return { ok: false, error: String(error.message || error) };
  }
  // Only remove the previous files after the new config is safely on disk.
  for (const stale of cleanup) {
    try { if (fs.existsSync(stale)) fs.unlinkSync(stale); } catch { /* old file may be in use */ }
  }

  const resolution = media.width ? `${media.width}x${media.height}` : undefined;
  const quality = media.fallbackFromVideo
    ? (media.kind === 'video' ? '备用动画（GIF 预览）' : `静态备用图${resolution ? `（${resolution}）` : ''}`)
    : media.gifFrame
      ? 'GIF 首帧（静态）'
      : media.hires
        ? '高清原图'
        : media.kind === 'image'
          ? '预览图（清晰度有限）'
          : media.alreadySafe
            ? '已是最佳格式'
            : media.unverified
              ? '原样导入（未检测编码）'
              : undefined;
  return {
    ok: true,
    imported: true,
    replaced,
    applied: apply,
    entry: { id: entryId, path: media.path, name },
    source: { id: item.id, title: item.title, type: item.type },
    media: {
      kind: media.kind, dynamic: media.dynamic,
      sizeMB: Math.round(media.bytes / 1024 / 1024 * 10) / 10,
      transcoded: Boolean(media.transcoded),
      alreadySafe: Boolean(media.alreadySafe),
      unverified: Boolean(media.unverified),
      fallbackFromVideo: Boolean(media.fallbackFromVideo),
      fallbackReason: media.fallbackReason || undefined,
      resolution,
      fps: media.fps ? Math.round(media.fps) : undefined,
      codec: media.codec || (media.kind === 'video' ? 'h264' : undefined),
      poster: media.posterPath ? true : false,
      quality
    },
    note: (media.fallbackFromVideo
      ? `视频未能转换（${media.fallbackReason || '未知原因'}），已自动改用${media.kind === 'video' ? 'GIF 预览动画' : '静态备用图'}。`
      : media.gifFrame
        ? '预览 GIF 已转为静态首帧（未找到 ffmpeg，动态转换不可用）。'
        : media.hires
          ? `已提取场景高清原图（${media.width}x${media.height}，静态）。`
          : media.kind === 'video'
            ? media.unverified
              ? '未检测到 ffmpeg/ffprobe，视频已原样导入；若黑屏或卡顿，请安装 ffmpeg 后运行 we_optimize_imported 修复。'
              : `视频已按壁纸安全规格处理（${resolution || '已压缩'}，H.264，无音轨）${media.posterPath ? '，并生成静态备用图' : ''}。`
            : '')
      + (apply
        ? '已写入 Yan 壁纸配置并设为当前壁纸。打开 Yan 设置页或重启应用后生效。'
        : '已加入 Yan 壁纸库（未应用）。可在设置页选择，或再次导入时 apply=true。')
  };
}

function describeImportedEntry(entry, selected) {
  const file = String(entry.path || '');
  const st = statSafe(file);
  const ext = path.extname(file).toLowerCase();
  const isVideo = VIDEO_ANY_EXTS.has(ext);
  const posterPath = isVideo ? posterPathFor(file) : '';
  let technical;
  if (isVideo && st) {
    const info = probeVideo(file);
    if (info && info.hasVideo) {
      technical = {
        codec: info.codec,
        profile: info.profile || undefined,
        pix: info.pix,
        width: info.width,
        height: info.height,
        fps: info.fps ? Math.round(info.fps * 10) / 10 : undefined,
        safe: isSafeVideo(info)
      };
    }
  }
  return {
    id: String(entry.id), name: String(entry.name || ''), path: file,
    fileExists: Boolean(st),
    selected,
    kind: isVideo ? 'video' : 'image',
    sizeMB: st ? Math.round(st.size / 1048576 * 10) / 10 : 0,
    posterPath: posterPath || undefined,
    posterExists: Boolean(posterPath && statSafe(posterPath)),
    technical,
    needsFix: isVideo && (!technical || !technical.safe)
  };
}

function toolListImported() {
  let cfg;
  try { ({ cfg } = readYanConfig()); } catch (error) {
    return { ok: false, error: `读取 Yan 配置失败：${error.message || error}` };
  }
  const w = wallpaperSection(cfg);
  const entries = w.custom
    .filter(entry => String(entry.id || '').startsWith(ENTRY_PREFIX))
    .map(entry => describeImportedEntry(entry, String(w.id || '') === String(entry.id)));
  const needingFix = entries.filter(entry => entry.needsFix).length;
  const missingPoster = entries.filter(entry => entry.kind === 'video' && entry.fileExists && !entry.posterExists).length;
  return {
    ok: true, total: entries.length, selectedId: String(w.id || ''),
    needingFix,
    missingPoster,
    entries
  };
}

async function toolOptimize(args = {}) {
  const rawId = String(args.id || '').trim();
  const wanted = rawId && !rawId.startsWith(ENTRY_PREFIX)
    ? `${ENTRY_PREFIX}${rawId.replace(/[^a-zA-Z0-9-]/g, '-')}`.slice(0, 96)
    : rawId;
  const force = args.force === true;
  const deadlineTotal = Date.now() + FFMPEG_TOTAL_MS;
  let cfg;
  try { ({ cfg } = readYanConfig()); } catch (error) {
    return { ok: false, error: `读取 Yan 配置失败：${error.message || error}` };
  }
  const w = wallpaperSection(cfg);
  const targets = w.custom.filter(entry =>
    String(entry.id || '').startsWith(ENTRY_PREFIX)
    && (!wanted || String(entry.id) === wanted));
  if (!targets.length) return { ok: false, error: wanted ? `壁纸库中没有 ${wanted}。` : '还没有导入过 WE 壁纸。' };

  const ffmpeg = findFfmpeg();
  const results = [];
  const replacements = new Map();
  const cleanup = [];

  for (const entry of targets) {
    const id = String(entry.id);
    const file = String(entry.path || '');
    if (Date.now() > deadlineTotal - 12000) {
      results.push({ id, name: entry.name, status: 'pending', note: '本次处理时间用尽，请再次执行修复以继续。' });
      continue;
    }
    const st = statSafe(file);
    if (!st) {
      results.push({ id, name: entry.name, status: 'missing', note: '文件已丢失，请重新导入该壁纸。' });
      continue;
    }
    const ext = path.extname(file).toLowerCase();
    if (!VIDEO_ANY_EXTS.has(ext)) {
      results.push({ id, name: entry.name, status: 'image', note: '静态图片无需优化。' });
      continue;
    }
    const posterPath = posterPathFor(file);
    const posterExists = Boolean(statSafe(posterPath));
    const info = probeVideo(file);
    const safe = isSafeVideo(info) && st.size <= MAX_BYTES;

    if (safe && posterExists && !force) {
      results.push({
        id, name: entry.name, status: 'ok',
        resolution: info ? `${info.width}x${info.height}` : undefined,
        note: '格式已兼容，无需处理。'
      });
      continue;
    }

    if (safe && !force) {
      let poster = posterExists;
      if (!poster && ffmpeg) {
        poster = await makePoster(file, posterPath, info, deadlineTotal);
      }
      results.push({
        id, name: entry.name, status: poster ? 'poster' : 'ok',
        resolution: info ? `${info.width}x${info.height}` : undefined,
        note: poster ? '格式已兼容，已补生成静态备用图。' : '格式已兼容；未找到 ffmpeg，暂未生成备用图。'
      });
      continue;
    }

    if (!ffmpeg) {
      results.push({ id, name: entry.name, status: 'skipped', note: '未找到 ffmpeg，无法重编码。安装 ffmpeg 后可重试。' });
      continue;
    }

    const safeId = id.replace(/^custom-we-/, '').replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 60);
    const target = path.join(uploadsDir(), `${Date.now()}_we_${safeId}.mp4`);
    try {
      const bytes = await normalizeVideo(file, target, info, Math.min(deadlineTotal - 3000, Date.now() + FFMPEG_TOTAL_MS));
      const poster = await makePoster(target, posterPathFor(target), probeVideo(target), deadlineTotal);
      replacements.set(id, { path: target, posterPath: poster ? posterPathFor(target) : '', name: String(entry.name || '') });
      cleanup.push(file, posterPath);
      const outInfo = probeVideo(target);
      results.push({
        id, name: entry.name, status: 'optimized',
        before: info ? `${info.codec} ${info.width}x${info.height}@${Math.round(info.fps)}` : undefined,
        after: outInfo ? `h264 ${outInfo.width}x${outInfo.height}@${Math.round(outInfo.fps)}` : undefined,
        sizeMB: Math.round(bytes / 1048576 * 10) / 10,
        poster,
        note: '已转换为壁纸安全规格（H.264/≤1080p/无音轨）并生成静态备用图。'
      });
    } catch (error) {
      try { if (fs.existsSync(target)) fs.unlinkSync(target); } catch { /* ignore */ }
      results.push({ id, name: entry.name, status: 'failed', note: String(error?.message || error) });
    }
  }

  let configUpdated = false;
  if (replacements.size) {
    try {
      updateYanConfig(next => {
        const section = wallpaperSection(next);
        for (const entry of section.custom) {
          const repl = replacements.get(String(entry.id || ''));
          if (!repl) continue;
          entry.path = repl.path;
          if (String(section.id || '') === String(entry.id)) section.path = repl.path;
        }
        next.wallpaper = section;
        return next;
      });
      configUpdated = true;
    } catch (error) {
      for (const repl of replacements.values()) {
        try { fs.unlinkSync(repl.path); } catch { /* ignore */ }
        if (repl.posterPath) try { fs.unlinkSync(repl.posterPath); } catch { /* ignore */ }
      }
      return { ok: false, error: `写入 Yan 配置失败：${String(error.message || error)}` };
    }
  }
  if (configUpdated) {
    for (const stale of cleanup) {
      try { if (stale && fs.existsSync(stale)) fs.unlinkSync(stale); } catch { /* ignore */ }
    }
  }
  const optimized = results.filter(r => r.status === 'optimized').length;
  const posterAdded = results.filter(r => r.status === 'poster').length;
  const pending = results.filter(r => r.status === 'pending').length;
  return {
    ok: true,
    optimized,
    pending,
    configUpdated,
    selected: String(w.id || ''),
    results,
    note: (optimized
      ? `已修复 ${optimized} 个视频壁纸。`
      : posterAdded
        ? `已为 ${posterAdded} 个视频补充静态备用图。`
        : pending
          ? '本次处理时间用尽。'
          : '没有需要处理的视频。')
      + (pending ? ` 还有 ${pending} 个未处理，请再次执行 we_optimize_imported 继续。` : '')
  };
}

function toolRemove(args = {}) {
  const rawId = String(args.id || '').trim();
  if (!rawId) return { ok: false, error: '缺少要移除的壁纸 id（we_list_imported 返回的 entry id）。' };
  const entryId = rawId.startsWith('custom-') ? rawId : `${ENTRY_PREFIX}${rawId.replace(/[^a-zA-Z0-9-]/g, '-')}`.slice(0, 96);
  const deleteFile = args.deleteFile === true;
  let removed = null;
  let wasSelected = false;
  try {
    updateYanConfig(cfg => {
      const w = wallpaperSection(cfg);
      const index = w.custom.findIndex(entry => String(entry.id || '') === entryId);
      if (index < 0) throw new Error(`壁纸库中没有 ${entryId}。`);
      removed = w.custom[index];
      wasSelected = String(w.id || '') === entryId;
      w.custom.splice(index, 1);
      if (wasSelected) { w.id = ''; w.path = ''; w.name = ''; }
      cfg.wallpaper = w;
      return cfg;
    });
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
  let fileDeleted = false;
  if (deleteFile && removed && isInsideUploads(String(removed.path || ''))) {
    try { fs.unlinkSync(removed.path); fileDeleted = true; } catch { /* file may be in use */ }
    try { fs.unlinkSync(posterPathFor(String(removed.path || ''))); } catch { /* ignore */ }
  }
  return {
    ok: true, removed: { id: entryId, name: removed.name },
    wasSelected, fileDeleted,
    note: wasSelected ? '该壁纸原为当前壁纸，已取消选择（恢复默认背景）。打开设置页或重启后生效。' : '已从壁纸库移除。'
  };
}

// ---------------------------------------------------------------------------
// Self-service gallery launcher
// ---------------------------------------------------------------------------

function galleryPort() {
  const value = Number(process.env.WE_BRIDGE_GALLERY_PORT || 43197);
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : 43197;
}

function probeGalleryPath(port, pathname) {
  return new Promise(resolve => {
    const req = require('http').get({ host: '127.0.0.1', port, path: pathname, timeout: 1500 }, res => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function probeGallery(port) {
  if (await probeGalleryPath(port, '/api/ping')) return true;
  // Older embedded backends may not expose /api/ping.
  return probeGalleryPath(port, '/api/status');
}

function openGalleryBrowser(url) {
  try {
    spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
      windowsHide: true, detached: true, stdio: 'ignore'
    }).unref();
  } catch { /* best-effort */ }
}

async function toolOpenGallery() {
  const port = galleryPort();
  const url = `http://127.0.0.1:${port}`;
  let running = await probeGallery(port);
  if (running) {
    openGalleryBrowser(url);
  } else {
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      WE_BRIDGE_GALLERY_PORT: String(port),
      WE_BRIDGE_YAN_DATA: yanDataDir()
    };
    const child = spawn(process.execPath, [path.join(__dirname, 'gallery.cjs')], {
      detached: true, stdio: 'ignore', windowsHide: true, env
    });
    child.unref();
    for (let i = 0; i < 24 && !running; i += 1) {
      await new Promise(r => setTimeout(r, 250));
      running = await probeGallery(port);
    }
  }
  if (!running) {
    return { ok: false, error: '自选面板启动失败。请确认插件包内 gallery.cjs 与 gallery.html 完整。' };
  }
  return {
    ok: true, url,
    note: '已在浏览器打开 WE 壁纸自选面板：浏览预览、点击即可导入/应用/移除。面板 30 分钟无操作自动关闭；导入后打开 Yan 设置页或重启生效。'
  };
}

// ---------------------------------------------------------------------------
// MCP protocol
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'we_status',
    description: '检测 Wallpaper Engine 安装、Steam 库、创意工坊壁纸数量、Yan 壁纸配置状态与 ffmpeg 可用性。导入前先调用确认环境。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => toolStatus()
  },
  {
    name: 'we_list_wallpapers',
    description: '列出 Wallpaper Engine 创意工坊订阅与本地项目壁纸：id、标题、类型(video/scene/web/application)、标签、大小、预览图路径、可导入性。支持关键词与类型过滤。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '按标题/ID/标签过滤的关键词（可选）' },
        type: { type: 'string', enum: ['video', 'scene', 'web', 'application'], description: '按壁纸类型过滤（可选）' },
        limit: { type: 'integer', description: '最多返回条数，默认 60，最大 300' }
      },
      additionalProperties: false
    },
    handler: async args => toolList(args)
  },
  {
    name: 'we_import_wallpaper',
    description: '把指定 Wallpaper Engine 壁纸导入 Yan 壁纸库。视频统一转换为壁纸安全规格（H.264 / 8-bit / ≤1920px / ≤60fps / 无音轨，超 50MB 自动压缩），避免 4K/HEVC 视频黑屏或卡顿；转换失败自动改用静态备用图（fallbackStatic=false 可关闭）。场景/网页类导入高清静态原图，GIF 预览转 MP4。默认导入并应用；打开 Yan 设置页或重启后生效。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'we_list_wallpapers 返回的壁纸 id（创意工坊数字 ID 或 local-xxx）' },
        name: { type: 'string', description: '在 Yan 中显示的壁纸昵称（可选，默认用 WE 标题）' },
        apply: { type: 'boolean', description: '导入后是否设为当前壁纸，默认 true' },
        mode: { type: 'string', enum: ['auto', 'video', 'preview'], description: 'auto=视频壁纸用视频、其他用预览图；video=强制视频；preview=强制静态预览图。默认 auto' },
        compress: { type: 'boolean', description: '超过 50MB 或编码不兼容的视频是否允许 ffmpeg 压缩/转码，默认 true' },
        fallbackStatic: { type: 'boolean', description: '视频无法转码时是否自动改用静态预览图，默认 true' }
      },
      required: ['id'],
      additionalProperties: false
    },
    handler: async args => toolImport(args)
  },
  {
    name: 'we_open_gallery',
    description: '在浏览器打开 WE 壁纸自选面板（本地网页，127.0.0.1）：用户自己浏览预览图、点击按钮即可导入/应用/移除壁纸，无需逐个口述。用户想自己方便地挑选导入时使用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => toolOpenGallery()
  },
  {
    name: 'we_list_imported',
    description: '列出已导入 Yan 壁纸库的 Wallpaper Engine 壁纸：昵称、文件、是否当前壁纸，以及视频编码/分辨率/是否兼容（needsFix）和静态备用图状态。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => toolListImported()
  },
  {
    name: 'we_optimize_imported',
    description: '一键修复已导入的视频壁纸：把 4K/HEVC/10-bit/高帧率视频重新转换为壁纸安全规格（H.264/≤1080p/≤60fps/无音轨），并为每个视频补生成静态备用图（播放失败时自动显示）。可用于旧版本导入后黑屏、卡顿、无法播放的壁纸。不传 id 时处理全部已导入视频。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '只修复指定 entry id（custom-we-xxx）；省略则修复全部已导入视频' },
        force: { type: 'boolean', description: '即使已兼容也强制重新编码，默认 false' }
      },
      additionalProperties: false
    },
    handler: async args => toolOptimize(args)
  },
  {
    name: 'we_remove_imported',
    description: '从 Yan 壁纸库移除已导入的 Wallpaper Engine 壁纸；可选同时删除上传的文件。若移除的是当前壁纸则恢复默认背景。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'we_list_imported 返回的 entry id（custom-we-xxx），也可传原始 WE id' },
        deleteFile: { type: 'boolean', description: '是否同时删除 uploads 中的媒体文件，默认 false' }
      },
      required: ['id'],
      additionalProperties: false
    },
    handler: async args => toolRemove(args)
  }
];

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0') return;
  const { id, method, params } = message;
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: String(params?.protocolVersion || '2025-03-26'),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'wallpaper-engine-bridge', version: VERSION }
      }
    });
    return;
  }
  if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS.map(({ handler, ...tool }) => tool) } });
    return;
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find(t => t.name === params?.name);
    let result;
    if (!tool) {
      result = { ok: false, error: `未知工具：${params?.name}` };
    } else {
      try { result = await tool.handler(params?.arguments || {}); }
      catch (error) { result = { ok: false, error: String(error?.message || error) }; }
    }
    send({
      jsonrpc: '2.0', id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: result.ok === false
      }
    });
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unsupported method: ${method}` } });
  }
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
      let message;
      try { message = JSON.parse(line); }
      catch (error) { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: String(error?.message || error) } }); continue; }
      void handle(message);
    }
  });
}

if (require.main === module) serve();

module.exports = { TOOLS, handle, discover, scanWallpapers, yanDataDir };