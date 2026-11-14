'use strict';
// yt-dlp native messaging host
// 由 launcher.exe 通过 stdin/stdout 原始字节中继调用；协议是 Chromium 的
// 4 字节小端长度前缀 + UTF-8 JSON。

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const YTDLP = resolveYtdlp();
const APP_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'ytdlp-browser');
const LOG_FILE = path.join(APP_DIR, 'host.log');
const COOKIE_DIR = path.join(APP_DIR, 'cookies');
const CONFIG_FILE = path.join(process.env.APPDATA || APP_DIR, 'yt-dlp', 'config');
const MAX_LOG_BYTES = 512 * 1024;
const HEARTBEAT_MS = 15000;

// yt-dlp 优先取环境变量，其次取 uv/pipx 常用的 ~/.local/bin，最后交给 PATH。
function resolveYtdlp() {
  if (process.env.YTDLP_EXE) return process.env.YTDLP_EXE;
  const local = path.join(os.homedir(), '.local', 'bin', 'yt-dlp.exe');
  try { if (fs.existsSync(local)) return local; } catch (e) {}
  return 'yt-dlp';
}

fs.mkdirSync(APP_DIR, { recursive: true });
fs.mkdirSync(COOKIE_DIR, { recursive: true });

function log(line) {
  try {
    const stat = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE) : null;
    if (stat && stat.size > MAX_LOG_BYTES) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    }
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\r\n`);
  } catch (e) { /* 日志失败不影响主流程 */ }
}

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  try {
    process.stdout.write(head);
    process.stdout.write(body);
  } catch (e) { log('send failed: ' + e.message); }
}

// ---------- 配置与工具 ----------

function defaultOutDir() {
  try {
    const text = fs.readFileSync(CONFIG_FILE, 'utf8');
    const m = text.match(/^\s*-P\s+"?([^"\r\n]+)"?\s*$/m);
    if (m) return m[1].trim();
  } catch (e) { /* 没有配置文件就走兜底 */ }
  return path.join(os.homedir(), 'Downloads', 'yt-dlp');
}

function runYtdlp(args, timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    const child = spawn(YTDLP, args, { windowsHide: true });
    const timer = timeoutMs ? setTimeout(() => { try { child.kill(); } catch (e) {} }, timeoutMs) : null;
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: err + e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

function writeCookies(netscape) {
  if (!netscape || !netscape.trim()) return null;
  const file = path.join(COOKIE_DIR, `cookies-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(file, netscape, { encoding: 'utf8', mode: 0o600 });
  return file;
}

function removeQuiet(file) {
  if (!file) return;
  try { fs.unlinkSync(file); } catch (e) {}
}

function buildArgs(opts, cookieFile) {
  const a = [
    '--no-warnings',
    '--newline',
    '--color', 'never',
    '--print', 'after_move:FILEPATH|%(filepath)s',
    '--no-simulate',
  ];
  // 只下字幕时没有媒体进度，进度模板只会吐 NA，跳过
  if (opts.mode !== 'subs') {
    a.push('--progress',
      '--progress-template',
      'download:[PROG] %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.speed)s %(progress.eta)s');
  }
  if (!opts.playlist) a.push('--no-playlist');

  switch (opts.mode) {
    case 'cap1080':
      a.push('-f', 'bv*[height<=1080]+ba/b[height<=1080]');
      break;
    case 'audio-mp3':
      a.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
      break;
    case 'audio-m4a':
      a.push('-f', 'ba[ext=m4a]/ba');
      break;
    case 'subs':
      // 只取字幕：--skip-download 不落视频，--convert-subs srt 统一成 srt；
      // --no-embed-thumbnail 挡掉配置里的 --embed-thumbnail，否则会白下一张封面图
      a.push('--skip-download', '--write-subs', '--write-auto-subs',
        '--convert-subs', 'srt', '--sub-langs', 'zh.*,en.*', '--no-embed-thumbnail');
      break;
    default:
      a.push('-f', 'bv*+ba/b');
  }
  if (opts.subs && opts.mode !== 'subs') {
    a.push('--write-subs', '--write-auto-subs', '--sub-langs', 'zh.*,en.*', '--embed-subs');
  }
  if (cookieFile) a.push('--cookies', cookieFile);
  a.push(opts.url);
  return a;
}

// ---------- 下载任务 ----------

let job = null; // { proc, cookieFile, cancelled, files, startedAt, lastError, mode }

const SUB_EXTS = new Set(['.srt', '.vtt', '.ass', '.ssa']);

// 只下字幕时 yt-dlp 不会产生 FILEPATH（没有媒体文件可 move），
// 所以按修改时间去输出目录里捡刚写出的字幕文件。
function collectSubs(dir, sinceMs) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return out; }
  for (const name of names) {
    if (!SUB_EXTS.has(path.extname(name).toLowerCase())) continue;
    const full = path.join(dir, name);
    let st;
    try { st = fs.statSync(full); } catch (e) { continue; }
    if (st.isFile() && st.mtimeMs >= sinceMs - 5000) out.push(full);
  }
  return out.sort();
}

function finish(payload) {
  if (!job) return;
  const elapsed = Math.round((Date.now() - job.startedAt) / 1000);
  let files = job.files.slice();
  if (files.length === 0 && job.mode === 'subs' && payload.code === 0) {
    files = collectSubs(defaultOutDir(), job.startedAt);
    log('subs collected: ' + files.length);
  }
  send(Object.assign({ type: 'done', elapsed, files }, payload));
  removeQuiet(job.cookieFile);
  if (job.heartbeat) clearInterval(job.heartbeat);
  job = null;
}

function startDownload(opts) {
  if (job) {
    send({ type: 'error', message: '已有任务在进行，请先取消或等待完成' });
    return;
  }
  if (!opts || !opts.url) {
    send({ type: 'error', message: '缺少 URL' });
    return;
  }

  const cookieFile = writeCookies(opts.cookies);
  const args = buildArgs(opts, cookieFile);
  log('download start: ' + JSON.stringify({ url: opts.url, mode: opts.mode, subs: !!opts.subs, playlist: !!opts.playlist, cookies: !!cookieFile }));

  job = {
    proc: null,
    cookieFile,
    cancelled: false,
    files: [],
    mode: opts.mode,
    startedAt: Date.now(),
    lastError: '',
    heartbeat: null,
    lastProgressAt: 0,
  };

  let proc;
  try {
    proc = spawn(YTDLP, args, { windowsHide: true });
  } catch (e) {
    send({ type: 'error', message: '无法启动 yt-dlp: ' + e.message });
    removeQuiet(cookieFile);
    job = null;
    return;
  }
  job.proc = proc;

  // yt-dlp 在合并/转码阶段可能几十秒没有输出，而 MV3 的 service worker
  // 会因闲置被回收。心跳把连接按住。
  job.heartbeat = setInterval(() => {
    if (job && job.proc && job.proc.exitCode === null) send({ type: 'tick' });
  }, HEARTBEAT_MS);

  const handleLine = (raw, isErr) => {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) return;
    if (line.startsWith('[PROG] ')) {
      const now = Date.now();
      if (now - job.lastProgressAt < 200) return; // 限速到 ~5 次/秒
      job.lastProgressAt = now;
      const [downloaded, total, speed, eta] = line.slice(7).split(' ');
      const num = (v) => (v === 'NA' || v === 'None' ? null : Number(v));
      send({
        type: 'progress',
        downloaded: num(downloaded),
        total: num(total),
        speed: num(speed),
        eta: num(eta),
      });
      return;
    }
    const fileMatch = line.match(/^FILEPATH\|(.+)$/);
    if (fileMatch) {
      job.files.push(fileMatch[1]);
      return;
    }
    if (isErr && !job.lastError) job.lastError = line.trim();
    log((isErr ? 'stderr: ' : 'out: ') + line);
    send({ type: 'log', line, isError: !!isErr });
  };

  let outBuf = '';
  let errBuf = '';
  const splitter = (chunk, isErr) => {
    let buf = isErr ? errBuf : outBuf;
    buf += chunk.toString('utf8');
    const lines = buf.split('\n');
    const rest = lines.pop();
    if (isErr) errBuf = rest; else outBuf = rest;
    lines.forEach((l) => handleLine(l, isErr));
  };

  proc.stdout.on('data', (d) => splitter(d, false));
  proc.stderr.on('data', (d) => splitter(d, true));
  proc.on('error', (e) => {
    send({ type: 'error', message: 'yt-dlp 启动失败: ' + e.message });
    finish({ code: -1, cancelled: false, error: e.message });
  });
  proc.on('close', (code) => {
    if (!job) return;
    finish({
      code,
      cancelled: job.cancelled,
      error: code === 0 ? null : (job.lastError || `yt-dlp 退出码 ${code}`),
    });
  });
}

function cancelDownload() {
  if (!job || !job.proc) {
    send({ type: 'error', message: '没有正在进行的任务' });
    return;
  }
  job.cancelled = true;
  log('cancel requested');
  try {
    spawn('taskkill', ['/PID', String(job.proc.pid), '/T', '/F'], { windowsHide: true });
  } catch (e) {
    try { job.proc.kill(); } catch (e2) {}
  }
}

// ---------- 其他动作 ----------

async function ping() {
  const v = await runYtdlp(['--version'], 20000);
  send({
    type: 'pong',
    ytdlp: (v.out || '').trim() || (v.err || '').trim().split('\n')[0] || 'missing',
    outDir: defaultOutDir(),
    busy: !!job,
    pid: process.pid,
  });
}

async function probe(opts) {
  const cookieFile = writeCookies(opts.cookies);
  const args = ['--no-warnings', '--simulate', '--color', 'never',
    '--print', '%(title)s|%(duration_string)s|%(uploader)s|%(channel)s|%(playlist_count)s'];
  if (!opts.playlist) args.push('--no-playlist');
  if (cookieFile) args.push('--cookies', cookieFile);
  args.push(opts.url);

  const r = await runYtdlp(args, 60000);
  removeQuiet(cookieFile);
  if (r.code !== 0) {
    send({ type: 'probe', ok: false, error: (r.err || '').trim().split('\n').slice(-2).join(' ') || `退出码 ${r.code}` });
    return;
  }
  const parts = (r.out || '').trim().split('|');
  send({
    type: 'probe',
    ok: true,
    title: parts[0] || '',
    duration: parts[1] || '',
    uploader: parts[2] || parts[3] || '',
    playlistCount: parts[4] && parts[4] !== 'NA' ? Number(parts[4]) : null,
  });
}

function openFolder(target) {
  if (!target) { send({ type: 'error', message: '没有可打开的文件' }); return; }
  let isFile = false;
  try { isFile = fs.statSync(target).isFile(); } catch (e) { isFile = false; }

  const dir = path.dirname(target);
  // 必须让命令行正好是 explorer.exe /select,"<path>"：
  // 走 cmd /c 会被 Node 的引号转义打乱，explorer 退回「文档」；
  // windowsVerbatimArguments 才能原样传递。
  try {
    if (isFile) {
      execFile('explorer.exe', ['/select,"' + target + '"'], { windowsVerbatimArguments: true }, () => {});
      log('explorer /select: ' + target);
      send({ type: 'opened', path: dir });
    } else {
      execFile('explorer.exe', ['"' + dir + '"'], { windowsVerbatimArguments: true }, () => {});
      log('explorer dir: ' + dir);
      send({ type: 'opened', path: dir });
    }
  } catch (e) {
    send({ type: 'error', message: '打开目录失败: ' + e.message });
  }
}

// ---------- 协议循环 ----------

function handle(msg) {
  const action = msg.action;
  switch (action) {
    case 'ping': ping(); break;
    case 'probe': probe(msg); break;
    case 'download': startDownload(msg); break;
    case 'cancel': cancelDownload(); break;
    case 'open': openFolder(msg.path); break;
    case 'log': log('[client] ' + String(msg.text).slice(0, 2000)); break;
    default: send({ type: 'error', message: '未知动作: ' + action });
  }
}

let inbox = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  inbox = Buffer.concat([inbox, chunk]);
  for (;;) {
    if (inbox.length < 4) return;
    const len = inbox.readUInt32LE(0);
    if (inbox.length < 4 + len) return;
    const body = inbox.subarray(4, 4 + len).toString('utf8');
    inbox = inbox.subarray(4 + len);
    let msg;
    try { msg = JSON.parse(body); } catch (e) { log('bad json: ' + body.slice(0, 200)); continue; }
    try { handle(msg); } catch (e) { log('handle error: ' + e.stack); send({ type: 'error', message: String(e.message) }); }
  }
});

process.stdin.on('end', () => {
  log('stdin closed, exiting');
  if (job && job.proc) { try { job.proc.kill(); } catch (e) {} }
  removeQuiet(job && job.cookieFile);
  process.exit(0);
});

process.on('uncaughtException', (e) => {
  log('uncaught: ' + e.stack);
  send({ type: 'error', message: '宿主异常: ' + e.message });
});

log('host started pid=' + process.pid);
