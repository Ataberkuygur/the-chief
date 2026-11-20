// Tab Bridge - MV3 service worker
// Transport: WebSocket ws://127.0.0.1:8765/ws (Chrome 116+ keeps a worker with an active WS alive;
// the server sends a ping every ~20s and we answer, so the worker is never idle-killed).
// Fallback: the original long-poll loop runs whenever the WS is not connected.
// Delivery is ack based: commands stay queued on the server until a result arrives, so a WS drop
// re-delivers anything unfinished instead of losing it. A seen/done cache makes re-delivery idempotent.
importScripts('win.js');
const BASE = 'http://127.0.0.1:8765';
const WS_URL = 'ws://127.0.0.1:8765/ws';
const attached = new Set();

let ws = null;
let wsOpen = false;
let wsFailures = 0;
let pollRunning = false;
let lastTick = 0;

const seen = new Set();          // command ids already accepted (bounded)
const done = new Map();          // id -> result message, so a re-delivery can be answered again

function remember(id) {
  seen.add(id);
  if (seen.size > 1000) seen.delete(seen.values().next().value);
}

function wsSend(obj) {
  if (!ws || !wsOpen) return false;
  try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
}

async function post(path, body) {
  try {
    await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) { /* server may be down */ }
}

chrome.debugger.onDetach.addListener((src, reason) => {
  if (src.tabId) attached.delete(src.tabId);
  post('/event', { type: 'detached', tabId: src.tabId, reason });
});

chrome.debugger.onEvent.addListener((src, method, params) => {
  if (!src.tabId) return;
  post('/event', { type: 'cdp', tabId: src.tabId, method, params });
});

const attaching = new Map();      // tabId -> in-flight attach promise (serializes concurrent attaches)
async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  if (attaching.has(tabId)) return attaching.get(tabId);
  const p = (async () => {
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
    } catch (e) {
      // "Another debugger is already attached ..." is usually our own attachment left behind by a
      // previous service-worker life (a command in flight when the worker was recycled). Detach the
      // stale one and attach again instead of failing the redelivered command.
      if (!/already attached/i.test(String(e && e.message || e))) throw e;
      try { await chrome.debugger.detach({ tabId }); } catch (_) {}
      await chrome.debugger.attach({ tabId }, '1.3');
    }
    attached.add(tabId);
  })().finally(() => attaching.delete(tabId));
  attaching.set(tabId, p);
  return p;
}

async function handle(c) {
  switch (c.cmd) {
    case 'ping': return { pong: true, ts: Date.now() };
    case 'reload': setTimeout(() => chrome.runtime.reload(), 200); return { reloading: true };
    case 'tabs': {
      const tabs = await chrome.tabs.query({});
      return tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId }));
    }
    case 'attach': await ensureAttached(c.tabId); return { attached: true };
    case 'detach': await chrome.debugger.detach({ tabId: c.tabId }); attached.delete(c.tabId); return { detached: true };
    case 'cdp': {
      await ensureAttached(c.tabId);
      const r = await chrome.debugger.sendCommand({ tabId: c.tabId }, c.method, c.params || {});
      return r === undefined ? {} : r;
    }
    case 'newtab': return newTabIn(c);
    case 'displays': case 'windows': case 'setdisplay': case 'newwin': case 'movetab': return winCmd(c);
    case 'nav': { await chrome.tabs.update(c.tabId, { url: c.url }); return { nav: c.url }; }
    case 'activate': { await chrome.tabs.update(c.tabId, { active: true }); return { ok: true }; }
    case 'close': { await chrome.tabs.remove(c.tabId); return { closed: true }; }
    case 'dl': {
      const opts = { url: c.url, conflictAction: 'uniquify' };
      if (c.filename) opts.filename = c.filename;
      if (c.saveAs) opts.saveAs = true;
      const id = await chrome.downloads.download(opts);
      return { downloadId: id };
    }
    case 'dlstatus': {
      const items = await chrome.downloads.search(c.query || { limit: 20, orderBy: ['-startTime'] });
      return items.map(d => ({ id: d.id, filename: d.filename, state: d.state, bytes: d.fileSize, received: d.bytesReceived, error: d.error, url: (d.url || '').slice(0, 120) }));
    }
    default: throw new Error('unknown cmd ' + c.cmd);
  }
}

function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label + ' timed out after ' + ms + 'ms')), ms); }),
  ]).finally(() => clearTimeout(t));
}

function ack(id) {
  wsSend({ type: 'ack', id });
}

function finish(c, msg) {
  done.set(c.id, msg);
  if (done.size > 500) done.delete(done.keys().next().value);
  if (!wsSend({ type: 'result', ...msg })) post('/result', msg);
}

// Idempotent under redelivery: a command id that is already accepted is only re-acked
// (and gets its cached result again if it already finished).
function runCommand(c) {
  if (!c || c.id === undefined) return;
  if (seen.has(c.id)) {
    ack(c.id);
    const d = done.get(c.id);
    if (d && !wsSend({ type: 'result', ...d })) post('/result', d);
    return;
  }
  remember(c.id);
  ack(c.id);
  withTimeout(handle(c), c.timeoutMs || 120000, c.cmd)
    .then(result => finish(c, { id: c.id, ok: true, result }))
    .catch(e => finish(c, { id: c.id, ok: false, error: String(e && e.message || e) }));
}

function scheduleReconnect() {
  wsFailures++;
  const delay = Math.min(5000, 300 * wsFailures);
  setTimeout(connectWS, delay);
}

function connectWS() {
  if (wsOpen) return;
  let sock;
  try { sock = new WebSocket(WS_URL); } catch (e) { scheduleReconnect(); return; }
  ws = sock;
  sock.onopen = () => {
    wsOpen = true;
    wsFailures = 0;
    wsSend({ type: 'hello', v: chrome.runtime.getManifest().version });
  };
  sock.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.type === 'cmd') runCommand(m.cmd);
    else if (m.type === 'ping') wsSend({ type: 'pong', ts: Date.now() });
  };
  sock.onclose = () => {
    wsOpen = false;
    if (ws === sock) ws = null;
    startPoll();
    scheduleReconnect();
  };
  sock.onerror = () => { try { sock.close(); } catch (e) {} };
}

// --- fallback long-poll (used only while the WS is down) ---
async function pollOnce() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000); // server answers within 15s; anything longer is a dead socket
  try {
    const r = await fetch(BASE + '/poll', { cache: 'no-store', signal: ctrl.signal });
    if (!r.ok) throw new Error('poll ' + r.status);
    const data = await r.json();
    for (const c of data.commands) runCommand(c);
  } finally { clearTimeout(t); }
}

async function startPoll() {
  if (pollRunning) return;
  pollRunning = true;
  try {
    while (!wsOpen) {
      lastTick = Date.now();
      try { await pollOnce(); }
      catch (e) { await new Promise(res => setTimeout(res, 2000)); }
    }
  } finally { pollRunning = false; }
}

// Self-heal: the alarm wakes the worker every 30s; reconnect the WS and restart polling if needed.
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  if (!wsOpen) connectWS();
  if (!pollRunning && !wsOpen) startPoll();
});
chrome.runtime.onStartup.addListener(() => { connectWS(); startPoll(); });
chrome.runtime.onInstalled.addListener(() => { connectWS(); startPoll(); });

connectWS();
startPoll();
