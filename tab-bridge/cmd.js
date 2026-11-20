// CLI: node cmd.js <cmdfile.json>   OR   node cmd.js --eval <tabId> <exprfile>
const http = require('http');
const fs = require('fs');

function post(path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: 8765, path, method: 'POST', headers: {'Content-Type':'application/json'} }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({status: res.statusCode, body: d}));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 130000, () => { req.destroy(new Error('client timeout')); });
    req.end(JSON.stringify(body));
  });
}
function get(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 8765, path }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve({status:res.statusCode,body:d})); }).on('error', reject);
  });
}

(async () => {
  const a = process.argv.slice(2);
  if (a[0] === 'health') { const r = await get('/health'); console.log(r.body); return; }
  if (a[0] === 'events') { const r = await get('/events?since=' + (a[1]||'0')); console.log(r.body); return; }
  let cmd;
  if (a[0] === 'eval') {
    const tabId = parseInt(a[1], 10);
    const expr = fs.readFileSync(a[2], 'utf8');
    cmd = { cmd: 'cdp', tabId, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } };
  } else {
    cmd = JSON.parse(fs.readFileSync(a[0], 'utf8').replace(/^﻿/, ''));
  }
  const r = await post('/cmd', cmd, (cmd.timeoutMs || 120000) + 15000);
  try { console.log(JSON.stringify(JSON.parse(r.body), null, 1)); } catch { console.log('HTTP ' + r.status + ': ' + r.body); }
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
