// 列出所有 target，并对能访问 chrome.runtime 的目标打印 manifest name/version，
// 用来确认扩展实际拿到的 ID 是否等于固定 ID。
const http = require('http');

const port = Number(process.argv[2] || 9334);

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function withTarget(t, fn) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const call = (method, params) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params: params || {} })); });
  const evalx = async (expr) => {
    const m = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (m.result && m.result.exceptionDetails) return 'ERR ' + (m.result.exceptionDetails.text || '');
    return m.result && m.result.result ? m.result.result.value : null;
  };
  try { await fn(evalx); } finally { ws.close(); }
}

(async () => {
  const list = await getJson('/json/list');
  console.log('targets:', list.length);
  for (const t of list) {
    const short = t.url.length > 90 ? t.url.slice(0, 90) + '…' : t.url;
    console.log(`\n[${t.type}] ${short}`);
    try {
      await withTarget(t, async (evalx) => {
        const has = await evalx('typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.getManifest === "function"');
        if (!has) { console.log('  (无 chrome.runtime)'); return; }
        const id = await evalx('chrome.runtime.id');
        const name = await evalx('chrome.runtime.getManifest().name');
        console.log('  id   =', id);
        console.log('  name =', name);
      });
    } catch (e) {
      console.log('  连接失败:', e.message);
    }
  }
})();
