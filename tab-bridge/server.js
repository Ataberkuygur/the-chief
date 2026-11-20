// Tab Bridge - local relay server
// Primary transport: WebSocket /ws (keeps the MV3 service worker alive, ack + redelivery on reconnect).
// Fallback: GET /poll long-poll, kept for older extensions and whenever the WS is down.
// Enqueue via POST /cmd; results via POST /result or WS; extension events via /event.
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = 8765;
const PING_MS = 20000;        // keepalive traffic that resets the MV3 service-worker idle timer
const CONNECTED_MS = 30000;   // /health: extension counts as connected this long after the last sign of life

const commands = new Map();   // id -> { cmd, sentAt, ackedAt }  (removed only when a result arrives)
const waiters = [];           // pending /poll responses (long poll)
const results = new Map();    // id -> { id, ok, result|error }
const events = [];            // buffered extension events (max 500)
let seq = 0;
let lastSeen = 0;
let wsClient = null;

function sendWs(obj) {
  if (!wsClient || wsClient.readyState !== 1) return false;
  try { wsClient.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
}

function pollable() {
  const now = Date.now();
  return [...commands.values()].filter(e => !e.sentAt || now - e.sentAt > 30000);
}

function deliver(entry) {
  if (sendWs({ type: 'cmd', cmd: entry.cmd })) { entry.sentAt = Date.now(); return; }
  if (waiters.length) {
    const w = waiters.shift();
    entry.sentAt = Date.now();
    w([entry.cmd]);
  }
}

function redeliverAll() {
  if (!wsClient || wsClient.readyState !== 1) return;
  for (const entry of commands.values()) {
    entry.sentAt = Date.now();
    try { wsClient.send(JSON.stringify({ type: 'cmd', cmd: entry.cmd })); } catch (e) {}
  }
}

// Only the extension (Origin chrome-extension://) and local tools (no Origin, e.g. tb.js) may talk to the bridge.
// A web page always sends its own Origin, and a rebinding page a foreign Host: both are refused.
function trusted(req) {
  const origin = req.headers.origin;
  if (origin && !origin.startsWith('chrome-extension://')) return false;
  const host = String(req.headers.host || '').toLowerCase();
  if (host !== '127.0.0.1:' + PORT && host !== 'localhost:' + PORT) return false;
  const site = req.headers['sec-fetch-site'];
  return !site || site === 'none' || !!origin;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  // no CORS headers: a web page may not read or drive the bridge
  if (!trusted(req)) { res.writeHead(403); return res.end('forbidden'); }

  if (url.pathname === '/poll' && req.method === 'GET') {
    lastSeen = Date.now();
    const respond = (cmds) => { try { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({commands:cmds})); } catch(e){} };
    const ready = pollable();
    if (ready.length) {
      for (const e of ready) e.sentAt = Date.now();
      return respond(ready.map(e => e.cmd));
    }
    const w = respond; waiters.push(w);
    const to = setTimeout(() => { const i = waiters.indexOf(w); if (i>=0) waiters.splice(i,1); respond([]); }, 15000);
    req.on('close', () => { if (res.writableFinished) return; clearTimeout(to); const i = waiters.indexOf(w); if (i>=0) waiters.splice(i,1); });
    return;
  }

  if ((url.pathname === '/result' || url.pathname === '/event') && req.method === 'POST') {
    lastSeen = Date.now();
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const j = JSON.parse(body);
        if (url.pathname === '/result') { results.set(j.id, j); commands.delete(j.id); }
        else { events.push(j); if (events.length > 500) events.shift(); }
      } catch (e) {}
      res.writeHead(200); res.end('ok');
    });
    return;
  }

  if (url.pathname === '/cmd' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch (e) { res.writeHead(400); return res.end('bad json'); }
      j.id = ++seq;
      const entry = { cmd: j, sentAt: 0, ackedAt: 0 };
      commands.set(j.id, entry);
      deliver(entry);
      const deadline = Date.now() + (j.timeoutMs || 120000);
      const check = () => {
        const r = results.get(j.id);
        if (r) { results.delete(j.id); res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify(r)); }
        if (Date.now() > deadline) { commands.delete(j.id); res.writeHead(504); return res.end('timeout'); }
        setTimeout(check, 150);
      };
      check();
    });
    return;
  }

  if (url.pathname === '/events' && req.method === 'GET') {
    const s = parseInt(url.searchParams.get('since') || '0', 10);
    res.writeHead(200, {'Content-Type':'application/json'});
    return res.end(JSON.stringify(events.slice(s).map((e,i)=>({idx:s+i, ...e})).concat()));
  }
  if (url.pathname === '/events_size' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify({size: events.length}));
  }
  if (url.pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type':'application/json'});
    return res.end(JSON.stringify({
      extConnected: !!wsClient || Date.now() - lastSeen < CONNECTED_MS,
      ws: !!wsClient,
      lastSeenAgoMs: lastSeen ? Date.now() - lastSeen : null,
      queued: commands.size,
    }));
  }
  res.writeHead(404); res.end('nf');
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 * 1024, verifyClient: ({ req }) => trusted(req) });

wss.on('connection', (ws) => {
  wsClient = ws;
  lastSeen = Date.now();
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; lastSeen = Date.now(); });
  ws.on('message', (buf) => {
    lastSeen = Date.now();
    let m; try { m = JSON.parse(buf.toString()); } catch (e) { return; }
    if (m.type === 'hello') { redeliverAll(); return; }
    if (m.type === 'ack') { const e = commands.get(m.id); if (e) e.ackedAt = Date.now(); return; }
    if (m.type === 'result') { results.set(m.id, m); commands.delete(m.id); return; }
    if (m.type === 'pong') return;
  });
  ws.on('close', () => { if (wsClient === ws) wsClient = null; });
  ws.on('error', () => { try { ws.close(); } catch (e) {} });

  redeliverAll();
});

// Server-driven keepalive: JSON ping (counts as WebSocket activity for the MV3 idle timer)
// plus a protocol ping to detect a dead socket.
setInterval(() => {
  if (!wsClient || wsClient.readyState !== 1) return;
  if (wsClient.isAlive === false) { try { wsClient.terminate(); } catch (e) {} wsClient = null; return; }
  wsClient.isAlive = false;
  try { wsClient.ping(); } catch (e) {}
  sendWs({ type: 'ping', ts: Date.now() });
}, PING_MS);

server.listen(PORT, '127.0.0.1', () => console.log('bridge listening on 127.0.0.1:' + PORT));
