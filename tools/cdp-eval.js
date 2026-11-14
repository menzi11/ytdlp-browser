// 通过 CDP 打开 popup 页、收集控制台错误并取关键 DOM 值。
// 用法：node tools/cdp-eval.js [port]
const http = require('http');

const port = Number(process.argv[2] || 9333);

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

(async () => {
  const list = await getJson('/json/list');
  const page = list.find((t) => t.type === 'page' && t.url.includes('popup.html'));
  if (!page) {
    console.log('找不到 popup 页，现有 target：', list.map((t) => t.url).join('\n'));
    return;
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const logs = [];

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled') {
      const args = (m.params.args || []).map((a) => a.value !== undefined ? a.value : a.description);
      logs.push(`[console.${m.params.type}] ` + args.join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      logs.push(`[exception] ${d.text} ${(d.exception && d.exception.description) || ''} @${d.url || ''}:${d.lineNumber}`);
    }
    if (m.method === 'Log.entryAdded') {
      logs.push(`[log.${m.params.entry.level}] ${m.params.entry.text}`);
    }
  };

  await new Promise((r) => (ws.onopen = r));
  const call = (method, params) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params: params || {} })); });

  await call('Runtime.enable');
  await call('Log.enable');
  await call('Page.enable');
  await call('Page.reload', { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 5000));

  const evalx = async (expr) => {
    const m = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (m.result && m.result.exceptionDetails) return 'ERR: ' + (m.result.exceptionDetails.exception || {}).description;
    return m.result && m.result.result ? m.result.result.value : null;
  };

  console.log('--- DOM ---');
  console.log('meta  :', await evalx("document.getElementById('meta').textContent"));
  console.log('stat  :', await evalx("document.getElementById('stat').textContent"));
  console.log('url   :', await evalx("document.getElementById('url').value"));
  console.log('title :', await evalx("document.getElementById('title').textContent"));
  console.log('err   :', await evalx("document.getElementById('err').hidden ? '(hidden)' : document.getElementById('err').textContent"));
  console.log('runtime.id:', await evalx('chrome.runtime.id'));
  console.log('--- sendMessage 探针 ---');
  console.log('resp  :', await evalx("chrome.runtime.sendMessage({cmd:'getState'}).then(r=>JSON.stringify(r).slice(0,200)).catch(e=>'REJECT: '+e.message)"));
  console.log('--- 控制台 ---');
  console.log(logs.length ? logs.join('\n') : '(无输出)');
  ws.close();
})();
