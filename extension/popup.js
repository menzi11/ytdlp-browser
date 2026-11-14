const $ = (id) => document.getElementById(id);
let state = null;
let currentUrl = '';

// 弹窗自己看不到控制台，把关键状态转发给宿主写进 host.log，方便从磁盘排查。
function diag(text) {
  try { chrome.runtime.sendMessage({ cmd: 'diag', text: String(text) }); } catch (e) { /* 忽略 */ }
}

window.addEventListener('error', (e) => diag('popup error: ' + e.message + ' @' + e.filename + ':' + e.lineno));
window.addEventListener('unhandledrejection', (e) => diag('popup rejection: ' + ((e.reason && e.reason.message) || e.reason)));

function fmtBytes(n) {
  if (!n && n !== 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + ' ' + units[i];
}

function fmtEta(s) {
  if (s === null || s === undefined || isNaN(s)) return '';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `剩余 ${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function setSeg(containerId, activeValue, attr) {
  document.querySelectorAll(`#${containerId} button`).forEach((b) => {
    b.classList.toggle('on', b.dataset[attr] === activeValue);
  });
}

function render(s) {
  if (!s) return;
  state = s;

  $('meta').textContent = s.ytdlp ? `yt-dlp ${s.ytdlp}` : '宿主未连接';
  $('meta').title = s.outDir ? `保存到 ${s.outDir}` : '';

  if (s.title) {
    $('info').hidden = false;
    $('title').textContent = s.title;
    const bits = [s.duration, s.uploader].filter(Boolean);
    $('sub').textContent = bits.join(' · ');
  }

  setSeg('mode', s.mode, 'mode');
  setSeg('audio', s.audio, 'audio');
  $('audioRow').hidden = s.mode !== 'audio';
  // 「仅字幕」模式下字幕必然要写，这个开关没有意义，藏掉避免误解
  $('subsRow').hidden = s.mode === 'subs';
  $('subs').checked = !!s.subs;
  $('playlist').checked = !!s.playlist;

  const downloading = s.status === 'downloading';
  $('start').disabled = downloading || !currentUrl;
  $('cancel').disabled = !downloading;

  const bar = $('bar');
  if (downloading) {
    if (s.total) {
      bar.classList.remove('busy');
      bar.style.width = s.percent + '%';
    } else {
      bar.classList.add('busy');
    }
    const parts = [];
    if (s.total) parts.push(s.percent + '%');
    if (s.downloaded) parts.push(fmtBytes(s.downloaded) + (s.total ? ' / ' + fmtBytes(s.total) : ''));
    if (s.speed) parts.push(fmtBytes(s.speed) + '/s');
    const eta = fmtEta(s.eta);
    if (eta) parts.push(eta);
    $('stat').textContent = parts.join(' · ') || '下载中…';
  } else {
    bar.classList.remove('busy');
    bar.style.width = s.status === 'done' ? '100%' : '0';
    $('stat').textContent =
      s.status === 'done' ? '下载完成' : s.status === 'error' ? '失败' : '就绪';
  }

  const files = $('files');
  if (s.files && s.files.length) {
    files.hidden = false;
    files.innerHTML = '';
    s.files.forEach((f) => {
      const row = document.createElement('div');
      row.className = 'row';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = f.split(/[\\/]/).pop();
      name.title = f;
      const btn = document.createElement('button');
      btn.textContent = '打开文件夹';
      btn.addEventListener('click', () => chrome.runtime.sendMessage({ cmd: 'open', path: f }));
      row.appendChild(name);
      row.appendChild(btn);
      files.appendChild(row);
    });
  } else {
    files.hidden = true;
  }

  const err = $('err');
  if (s.error) {
    err.hidden = false;
    err.textContent = s.error;
  } else {
    err.hidden = true;
  }
}

function ask(cmd, extra) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(Object.assign({ cmd }, extra || {}), (resp) => {
      void chrome.runtime.lastError;
      resolve(resp);
    });
  });
}

function probe() {
  if (!currentUrl || !/^https?:/i.test(currentUrl)) return;
  chrome.runtime.sendMessage({ cmd: 'probe', url: currentUrl });
}

// ---------- 事件 ----------

$('url').addEventListener('input', (e) => {
  currentUrl = e.target.value.trim();
  $('start').disabled = state && state.status === 'downloading' ? true : !currentUrl;
});

$('mode').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  $('audioRow').hidden = btn.dataset.mode !== 'audio';
  setSeg('mode', btn.dataset.mode, 'mode');
  chrome.runtime.sendMessage({ cmd: 'setPrefs', mode: btn.dataset.mode });
  render(Object.assign({}, state, { mode: btn.dataset.mode }));
});

$('audio').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  setSeg('audio', btn.dataset.audio, 'audio');
  chrome.runtime.sendMessage({ cmd: 'setPrefs', audio: btn.dataset.audio });
  render(Object.assign({}, state, { audio: btn.dataset.audio }));
});

$('subs').addEventListener('change', (e) => {
  chrome.runtime.sendMessage({ cmd: 'setPrefs', subs: e.target.checked });
});

$('playlist').addEventListener('change', (e) => {
  chrome.runtime.sendMessage({ cmd: 'setPrefs', playlist: e.target.checked });
  probe();
});

$('start').addEventListener('click', () => {
  diag('start clicked url=' + currentUrl + ' mode=' + (state && state.mode) + ' audio=' + (state && state.audio));
  ask('start', {
    url: currentUrl,
    mode: state.mode,
    audio: state.audio,
    subs: $('subs').checked,
    playlist: $('playlist').checked,
  });
});

$('cancel').addEventListener('click', () => ask('cancel'));

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.evt === 'state') render(msg.state);
});

// ---------- 启动 ----------

(async function init() {
  diag('init start');
  let resp = await ask('getState');
  if (!resp || !resp.state) {
    await new Promise((r) => setTimeout(r, 400));
    resp = await ask('getState');
  }
  diag('getState -> ' + JSON.stringify(resp || null).slice(0, 300));
  if (resp && resp.state) render(resp.state);

  let tabUrl = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && /^https?:/i.test(tab.url)) tabUrl = tab.url;
  } catch (e) {
    diag('tabs.query failed: ' + e.message);
  }
  diag('tab url = ' + tabUrl);

  if (tabUrl) {
    currentUrl = tabUrl;
    $('url').value = tabUrl;
    $('start').disabled = false;
    if (!state || state.url !== tabUrl) probe();
  }

  ask('ping');
  setTimeout(() => {
    diag('t+1s meta=' + $('meta').textContent + ' | stat=' + $('stat').textContent + ' | infoHidden=' + $('info').hidden);
  }, 1200);
})();
