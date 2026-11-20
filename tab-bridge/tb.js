// tb.js — quick CLI for Tab Bridge (no JSON files needed). Sees ALL Chrome tabs (not just a tab group).
//   node tb.js health
//   node tb.js reload                     reload the extension (chrome.runtime.reload)
//   node tb.js tabs [filter]              list tabs (filter by url/title substring)
//   node tb.js eval <tabId> "<js expr>"    run JS in tab, prints value (awaits promises)
//   node tb.js nav <tabId> <url>
//   node tb.js newtab <url> [display]     opens in the bridge window of that monitor (default: the saved default, first = primary)
//   node tb.js displays                   monitors (index 0 = primary), bounds
//   node tb.js windows                    Chrome windows with the monitor index each sits on
//   node tb.js newwin [url] [display]     make/get the bridge window on a monitor (maximized), optional first tab
//   node tb.js movetab <tabId> [display|w<windowId>]   move a tab into a monitor's bridge window (e.g. the Drive tab)
//   node tb.js setdisplay <primary|secondary|N|any>   default monitor for newtab ('any' = old behaviour)
//   node tb.js activate <tabId>
//   node tb.js close <tabId>
//   node tb.js dl <url> [filename]         Chrome download (uses user's logged-in session, e.g. Google Drive)
//   node tb.js dlstatus
//   node tb.js shot <tabId> <out.png>      screenshot via CDP
//   node tb.js pause-media                 pause every playing <video>/<audio> in all tabs (e.g. YouTube)
const http = require('http');
const fs = require('fs');
const PORT = 8765;

function req(method, path, body, timeoutMs = 135000) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method, headers: { 'Content-Type': 'application/json' } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', e => reject(new Error(e.code === 'ECONNREFUSED'
      ? 'bridge not running -> run start-bridge.sh (macOS/Linux) or start-bridge.ps1 (Windows) in the tab-bridge folder'
      : e.message)));
    r.setTimeout(timeoutMs, () => r.destroy(new Error('client timeout')));
    r.end(body ? JSON.stringify(body) : undefined);
  });
}
async function cmd(c) {
  const r = await req('POST', '/cmd', c, (c.timeoutMs || 120000) + 15000);
  let j; try { j = JSON.parse(r.body); } catch { throw new Error('HTTP ' + r.status + ': ' + r.body); }
  if (!j.ok) throw new Error(j.error);
  return j.result;
}
const evalIn = (tabId, expression) => cmd({ cmd: 'cdp', tabId, method: 'Runtime.evaluate',
  params: { expression, returnByValue: true, awaitPromise: true } }).then(r => r.exceptionDetails ? { error: r.exceptionDetails.text, detail: r.result && r.result.description } : r.result.value);
const out = v => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1));

(async () => {
  const [op, a1, a2] = process.argv.slice(2);
  switch (op) {
    case 'health': return out(JSON.parse((await req('GET', '/health')).body));
    case 'ping': return out(await cmd({ cmd: 'ping', timeoutMs: 10000 }));
    case 'reload': return out(await cmd({ cmd: 'reload', timeoutMs: 10000 }));
    case 'tabs': {
      const tabs = await cmd({ cmd: 'tabs', timeoutMs: 10000 });
      const f = (a1 || '').toLowerCase();
      return out(tabs.filter(t => !f || (t.url + ' ' + t.title).toLowerCase().includes(f)).map(t => `${t.id}\t${t.active ? '*' : ' '}\t${t.title}\t${t.url}\tw${t.windowId}`).join('\n'));
    }
    case 'eval': return out(await evalIn(+a1, a2));
    case 'nav': return out(await cmd({ cmd: 'nav', tabId: +a1, url: a2 }));
    case 'newtab': return out(await cmd({ cmd: 'newtab', url: a1, display: a2 }));
    case 'displays': return out(await cmd({ cmd: 'displays', timeoutMs: 10000 }));
    case 'windows': return out(await cmd({ cmd: 'windows', timeoutMs: 10000 }));
    case 'newwin': return out(await cmd({ cmd: 'newwin', url: a1 && !/^(primary|secondary|\d+|any)$/.test(a1) ? a1 : undefined, display: a2 || (/^(primary|secondary|\d+|any)$/.test(a1 || '') ? a1 : undefined) }));
    case 'movetab': return out(await cmd({ cmd: 'movetab', tabId: +a1, ...(/^w\d+$/.test(a2 || '') ? { windowId: +a2.slice(1) } : { display: a2 }) }));
    case 'setdisplay': return out(await cmd({ cmd: 'setdisplay', display: a1 }));
    case 'activate': return out(await cmd({ cmd: 'activate', tabId: +a1 }));
    case 'close': return out(await cmd({ cmd: 'close', tabId: +a1 }));
    case 'dl': return out(await cmd({ cmd: 'dl', url: a1, filename: a2 }));
    case 'dlstatus': return out(await cmd({ cmd: 'dlstatus' }));
    case 'shot': {
      const r = await cmd({ cmd: 'cdp', tabId: +a1, method: 'Page.captureScreenshot', params: { format: 'png' } });
      fs.writeFileSync(a2, Buffer.from(r.data, 'base64')); return out('saved ' + a2);
    }
    case 'pause-media': {
      const tabs = await cmd({ cmd: 'tabs', timeoutMs: 10000 });
      for (const t of tabs.filter(t => /^https?:/.test(t.url))) {
        try {
          const n = await evalIn(t.id, `(()=>{let n=0;document.querySelectorAll('video,audio').forEach(m=>{if(!m.paused){m.pause();n++}});return n})()`);
          if (n) console.log(`paused ${n} in ${t.id} ${t.title}`);
        } catch (e) { /* tab not attachable */ }
      }
      return;
    }
    default:
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').filter(l => l.startsWith('//')).join('\n'));
  }
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
