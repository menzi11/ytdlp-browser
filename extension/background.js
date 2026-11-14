// 后台 service worker：唯一持有 native messaging 端口的地方。
// 弹窗只通过 runtime.sendMessage 下命令、收状态快照，避免两个端口各起一个宿主进程。

const HOST_NAME = 'com.mengke.ytdlp';
const MENU_ID = 'ytdlp-download';
const LOG_LIMIT = 40;

let port = null;
let saveTimer = null;

const state = {
  schema: 2,
  status: 'idle',      // idle | downloading | done | error
  url: '',
  mode: 'best',        // best | cap1080 | audio
  audio: 'mp3',        // mp3 | m4a
  subs: true,          // 默认嵌入字幕
  playlist: false,
  percent: 0,
  downloaded: 0,
  total: 0,
  speed: 0,
  eta: 0,
  files: [],
  error: null,
  log: [],
  startedAt: 0,
  ytdlp: '',
  outDir: '',
  title: '',
  duration: '',
  uploader: '',
};

// ---------- 状态广播与持久化 ----------

function badge(text, color) {
  chrome.action.setBadgeText({ text: text || '' }).catch(() => {});
  if (color) chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
}

function persistNow() {
  chrome.storage.local.set({ state }).catch(() => {});
}

function persistSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; persistNow(); }, 1000);
}

function setState(patch) {
  Object.assign(state, patch);
  if (state.status === 'downloading') {
    badge(state.total ? state.percent + '%' : '…', '#2563eb');
  } else if (state.status === 'done') {
    badge('✓', '#16a34a');
  } else if (state.status === 'error') {
    badge('!', '#dc2626');
  } else {
    badge('', '#000000');
  }
  persistSoon();
  chrome.runtime.sendMessage({ evt: 'state', state }).catch(() => {});
}

// ---------- 与宿主通信 ----------

function ensurePort() {
  if (port) return port;
  port = chrome.runtime.connectNative(HOST_NAME);
  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    port = null;
    if (state.status === 'downloading') {
      setState({
        status: 'error',
        error: '宿主连接断开：' + (err && err.message ? err.message : '浏览器回收了后台，或宿主未注册'),
      });
    }
  });
  return port;
}

function sendToHost(msg) {
  try {
    ensurePort().postMessage(msg);
    return true;
  } catch (e) {
    setState({ status: 'error', error: '无法连接本地宿主：' + e.message });
    return false;
  }
}

function onHostMessage(msg) {
  switch (msg.type) {
    case 'tick':
      break; // 心跳，只为按住 service worker
    case 'pong':
      setState({ ytdlp: msg.ytdlp, outDir: msg.outDir });
      break;
    case 'probe':
      setState({
        title: msg.ok ? msg.title : '',
        duration: msg.ok ? msg.duration : '',
        uploader: msg.ok ? msg.uploader : '',
        error: msg.ok ? null : msg.error,
      });
      break;
    case 'progress': {
      const percent = msg.total ? Math.min(100, Math.round((msg.downloaded / msg.total) * 100)) : 0;
      setState({
        downloaded: msg.downloaded || 0,
        total: msg.total || 0,
        speed: msg.speed || 0,
        eta: msg.eta === null ? null : msg.eta,
        percent,
      });
      break;
    }
    case 'log': {
      const log = state.log.slice(-LOG_LIMIT + 1);
      log.push({ line: msg.line, isError: !!msg.isError });
      setState({ log });
      break;
    }
    case 'done':
      setState({
        status: msg.cancelled ? 'idle' : msg.code === 0 ? 'done' : 'error',
        files: msg.files || [],
        error: msg.cancelled ? null : msg.error,
        percent: msg.code === 0 ? 100 : state.percent,
      });
      if (msg.code === 0 && msg.files && msg.files.length) {
        notifyDone(msg.files);
      }
      break;
    case 'error':
      setState({ status: 'error', error: msg.message });
      break;
    default:
      break;
  }
}

function notifyDone(files) {
  const name = files[0].split(/[\\/]/).pop();
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: '下载完成',
    message: files.length > 1 ? `${name} 等 ${files.length} 个文件` : name,
  }).catch(() => {});
}

// ---------- cookie ----------

async function netscapeCookies(url) {
  let list = [];
  try {
    list = await chrome.cookies.getAll({ url });
  } catch (e) {
    return '';
  }
  if (!list.length) return '';
  const head = ['# Netscape HTTP Cookie File'];
  const rows = list
    .filter((c) => c.name)
    .map((c) =>
      [
        c.domain,
        c.hostOnly ? 'FALSE' : 'TRUE',
        c.path || '/',
        c.secure ? 'TRUE' : 'FALSE',
        Math.floor(c.expirationDate || 0),
        c.name,
        c.value,
      ].join('\t')
    );
  return head.concat(rows).join('\n') + '\n';
}

const HOST_MODE = { best: 'best', cap1080: 'cap1080', audio: null, subs: 'subs' };

function hostMode() {
  if (state.mode !== 'audio') return HOST_MODE[state.mode] || 'best';
  return state.audio === 'm4a' ? 'audio-m4a' : 'audio-mp3';
}

// ---------- 命令 ----------

async function startDownload(opts) {
  const url = (opts && opts.url) || state.url;
  if (!url) {
    setState({ status: 'error', error: '没有可下载的地址' });
    return;
  }
  if (state.status === 'downloading') {
    setState({ status: 'error', error: '已有任务在进行' });
    return;
  }
  setState({
    status: 'downloading',
    url,
    mode: (opts && opts.mode) || state.mode,
    audio: (opts && opts.audio) || state.audio,
    subs: opts && typeof opts.subs === 'boolean' ? opts.subs : state.subs,
    playlist: opts && typeof opts.playlist === 'boolean' ? opts.playlist : state.playlist,
    percent: 0,
    downloaded: 0,
    total: 0,
    speed: 0,
    eta: null,
    files: [],
    error: null,
    log: [],
    startedAt: Date.now(),
  });

  const cookies = await netscapeCookies(url);
  sendToHost({
    action: 'download',
    url,
    mode: hostMode(),
    subs: state.subs,
    playlist: state.playlist,
    cookies,
  });
}

async function doProbe(url) {
  const cookies = await netscapeCookies(url);
  sendToHost({ action: 'probe', url, playlist: state.playlist, cookies });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.cmd) return;
  switch (msg.cmd) {
    case 'getState':
      sendResponse({ state });
      return false;
    case 'ping':
      sendToHost({ action: 'ping' });
      sendResponse({ ok: true });
      return false;
    case 'probe':
      doProbe(msg.url);
      sendResponse({ ok: true });
      return false;
    case 'start':
      startDownload(msg);
      sendResponse({ ok: true });
      return true;
    case 'setPrefs': {
      const patch = {};
      if (msg.mode) patch.mode = msg.mode;
      if (msg.audio) patch.audio = msg.audio;
      if (typeof msg.subs === 'boolean') patch.subs = msg.subs;
      if (typeof msg.playlist === 'boolean') patch.playlist = msg.playlist;
      setState(patch);
      sendResponse({ ok: true });
      return false;
    }
    case 'diag':
      sendToHost({ action: 'log', text: msg.text });
      sendResponse({ ok: true });
      return false;
    case 'cancel':
      sendToHost({ action: 'cancel' });
      sendResponse({ ok: true });
      return false;
    case 'open':
      sendToHost({ action: 'open', path: msg.path });
      sendResponse({ ok: true });
      return false;
    default:
      sendResponse({ ok: false, error: '未知命令' });
      return false;
  }
});

// ---------- 右键菜单 ----------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: '用 yt-dlp 下载此页',
      contexts: ['page', 'link', 'video', 'audio'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== MENU_ID) return;
  const url = info.linkUrl || info.srcUrl || info.pageUrl;
  if (!url) return;
  startDownload({ url, mode: 'best' });
});

// ---------- 启动时恢复 ----------

chrome.storage.local.get('state').then(({ state: saved }) => {
  if (!saved) return;
  Object.assign(state, saved);
  // schema 2 起「嵌入字幕」默认开启；老配置里存着的 subs:false 要升级掉
  if (saved.schema !== 2) {
    state.subs = true;
    state.schema = 2;
  }
  if (saved.status === 'downloading') {
    setState({ status: 'error', error: '上次的任务被浏览器中途回收，已中断' });
  } else {
    setState({});
  }
}).catch(() => {});
