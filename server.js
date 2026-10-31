'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000;
const DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUB = path.join(__dirname, 'public');
const AM = [1000, 2000, 3000, 5000, 10000, 20000, 30000, 40000, 50000, 75000, 100000, 200000, 300000, 500000, 1000000];
const STEP = [0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 4, 4, 4, 5];
const QT = 30000, GRACE = +process.env.GRACE_MS || 1500, PAUSE = +process.env.PAUSE_MS || 6000;
const safe = s => (s > 10 ? AM[10] : s > 4 ? AM[4] : 0);

// ---- Base de questions : [question, A, B, C, D, indexBonneReponse, niveau 0-5]
const Q = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));
const XF = path.join(DIR, 'extra.json');
let EXTRA = [];
try { EXTRA = JSON.parse(fs.readFileSync(XF, 'utf8')); Q.push(...EXTRA); } catch (e) {}
const persist = () => { try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(XF, JSON.stringify(EXTRA)); } catch (e) { console.error('Sauvegarde impossible :', e.message); } };
const validRow = r => Array.isArray(r) && r.length === 7 && r.slice(0, 5).every(x => typeof x === 'string' && x.trim() && x.length < 300) &&
  Number.isInteger(r[5]) && r[5] >= 0 && r[5] < 4 && Number.isInteger(r[6]) && r[6] >= 0 && r[6] < 6;
const stats = () => ({ total: Q.length, extra: EXTRA.length, levels: [0, 1, 2, 3, 4, 5].map(l => Q.filter(q => q[6] === l).length) });

// ---- HTTP (site statique + API)
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
const json = (res, c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
const server = http.createServer((req, res) => {
  let u; try { u = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); return res.end(); }
  if (u.pathname === '/health') return res.end('ok');
  if (u.pathname === '/api/stats') return json(res, 200, stats());
  if (u.pathname === '/api/questions' && req.method === 'POST') {
    let b = ''; req.on('data', d => { b += d; if (b.length > 2e6) req.destroy(); });
    return req.on('end', () => {
      try {
        const { key, rows } = JSON.parse(b);
        if (process.env.ADMIN_KEY && key !== process.env.ADMIN_KEY) return json(res, 403, { error: 'Code admin incorrect.' });
        let added = 0, dup = 0, bad = 0;
        (Array.isArray(rows) ? rows : []).forEach(r => {
          if (!validRow(r)) return bad++;
          r = r.map((x, i) => (i < 5 ? x.trim() : x));
          if (Q.some(q => q[0].toLowerCase() === r[0].toLowerCase())) return dup++;
          Q.push(r); EXTRA.push(r); added++;
        });
        if (added) persist();
        json(res, 200, { added, dup, bad, ...stats() });
      } catch (e) { json(res, 400, { error: 'Requête invalide.' }); }
    });
  }
  let p; try { p = path.normalize(decodeURIComponent(u.pathname)); } catch (e) { res.writeHead(400); return res.end(); }
  if (p === '/' || p === path.sep) p = '/index.html';
  const f = path.join(PUB, p);
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Introuvable'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(data);
  });
});

// ---- Salles
const rooms = new Map();
const rnd = n => Math.floor(Math.random() * n);
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const bc = (r, o) => r.players.forEach(p => send(p.ws, o));
const newCode = () => { const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let c; do { c = Array.from({ length: 4 }, () => L[rnd(L.length)]).join(''); } while (rooms.has(c)); return c; };
const pub = r => ({ t: 'room', code: r.code, host: r.host, phase: r.phase, step: r.step,
  players: [...r.players.values()].map(p => ({ id: p.id, name: p.name, alive: p.alive, gain: p.gain, a: p.answer !== null, on: !!p.ws, f: p.f })) });
const rank = r => [...r.players.values()].map(p => ({ id: p.id, name: p.name, gain: p.gain, time: Math.round(p.time), alive: p.alive }))
  .sort((a, b) => b.gain - a.gain || a.time - b.time);

function join(ws, m, create) {
  const name = String(m.name || '').trim().slice(0, 16);
  if (!name) return send(ws, { t: 'err', m: 'Entrez votre prénom.' });
  let r, p;
  if (create) {
    r = { code: newCode(), players: new Map(), phase: 'lobby', step: -1, used: new Set(), cur: null, host: null, timer: null, last: Date.now() };
    rooms.set(r.code, r);
  } else {
    r = rooms.get(String(m.room || '').toUpperCase());
    if (!r) return send(ws, { t: 'err', m: 'Salle introuvable.', fatal: 1 });
    p = r.players.get(m.pid);
  }
  if (!p) {
    if (r.phase !== 'lobby') return send(ws, { t: 'err', m: 'La partie a déjà commencé.', fatal: 1 });
    if (r.players.size >= 20) return send(ws, { t: 'err', m: 'La salle est pleine (20 joueurs).', fatal: 1 });
    p = { id: crypto.randomUUID(), name, ws: null, alive: true, gain: 0, time: 0, answer: null, at: 0, f: false, hid: [] };
    r.players.set(p.id, p);
  }
  p.ws = ws; ws.pid = p.id; ws.room = r.code; r.last = Date.now();
  if (!r.host || !r.players.get(r.host)) r.host = p.id;
  send(ws, { t: 'joined', pid: p.id, code: r.code });
  bc(r, pub(r));
  if (r.phase === 'q') sendQ(r, p);
  if (r.phase === 'end') send(ws, { t: 'end', ranking: rank(r) });
}
const sendQ = (r, p) => send(p.ws, { t: 'q', step: r.step, q: r.cur[0], a: r.cur.slice(1, 5), endAt: r.endAt, now: Date.now(), alive: p.alive, hid: p.hid, sel: p.answer });

function begin(r) {
  r.step = -1; r.used = new Set();
  r.players.forEach(p => { p.alive = true; p.gain = 0; p.time = 0; p.f = false; p.answer = null; p.hid = []; });
  nextQ(r);
}
function nextQ(r) {
  r.step++; r.phase = 'q';
  const lv = STEP[r.step], all = Q.map((q, i) => i);
  let pool = all.filter(i => Q[i][6] === lv && !r.used.has(i));
  if (!pool.length) pool = all.filter(i => Q[i][6] === lv);
  if (!pool.length) pool = all;
  const i = pool[rnd(pool.length)]; r.used.add(i); r.cur = Q[i];
  r.startAt = Date.now() + GRACE; r.endAt = r.startAt + QT;
  r.players.forEach(p => { p.answer = null; p.hid = []; });
  r.players.forEach(p => sendQ(r, p));
  bc(r, pub(r));
  clearTimeout(r.timer); r.timer = setTimeout(() => reveal(r), QT + GRACE + 300);
}
function checkAll(r) {
  if (r.phase !== 'q') return;
  const pl = [...r.players.values()].filter(p => p.alive && p.ws);
  if (pl.every(p => p.answer !== null)) { clearTimeout(r.timer); r.timer = setTimeout(() => reveal(r), 700); }
}
function reveal(r) {
  if (r.phase !== 'q') return;
  r.phase = 'reveal'; clearTimeout(r.timer);
  const c = r.cur[5], res = [];
  r.players.forEach(p => {
    if (!p.alive) return;
    const ok = p.answer === c;
    if (ok) { p.gain = AM[r.step]; p.time += Math.min(QT, Math.max(0, p.at - r.startAt)) / 1000; }
    else { p.alive = false; p.gain = safe(r.step); p.time += QT / 1000; }
    res.push({ id: p.id, name: p.name, pick: p.answer, ok, gain: p.gain });
  });
  bc(r, { t: 'reveal', step: r.step, correct: c, results: res, nextAt: Date.now() + PAUSE, now: Date.now() });
  bc(r, pub(r));
  r.timer = setTimeout(() => {
    const alive = [...r.players.values()].some(p => p.alive);
    if (r.step >= 14 || !alive) { r.phase = 'end'; bc(r, { t: 'end', ranking: rank(r) }); bc(r, pub(r)); } else nextQ(r);
  }, PAUSE);
}

function onMsg(ws, m) {
  if (m.t === 'create') return join(ws, m, true);
  if (m.t === 'join') return join(ws, m, false);
  const r = rooms.get(ws.room), p = r && r.players.get(ws.pid);
  if (!p) return;
  r.last = Date.now();
  if (m.t === 'start' && r.host === p.id && r.phase === 'lobby') begin(r);
  else if (m.t === 'again' && r.host === p.id && r.phase === 'end') {
    r.players.forEach((x, id) => { if (!x.ws) r.players.delete(id); });
    r.phase = 'lobby'; r.step = -1; r.players.forEach(x => { x.alive = true; x.gain = 0; });
    bc(r, pub(r));
  } else if (m.t === 'answer' && r.phase === 'q' && p.alive && p.answer === null && Number.isInteger(m.i) && m.i >= 0 && m.i < 4 && !p.hid.includes(m.i) && Date.now() <= r.endAt + 500) {
    p.answer = m.i; p.at = Date.now(); bc(r, pub(r)); checkAll(r);
  } else if (m.t === 'fifty' && r.phase === 'q' && p.alive && !p.f && r.step >= 4 && p.answer === null) {
    p.f = true;
    p.hid = [0, 1, 2, 3].filter(i => i !== r.cur[5]).sort(() => Math.random() - .5).slice(0, 2);
    send(p.ws, { t: 'hid', idx: p.hid }); bc(r, pub(r));
  } else if (m.t === 'walk' && r.phase === 'q' && p.alive && r.step > 0 && p.answer === null) {
    p.gain = AM[r.step - 1]; p.alive = false; bc(r, pub(r)); checkAll(r);
  }
}

const wss = new WebSocketServer({ server, maxPayload: 4096 });
wss.on('connection', ws => {
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', d => { let m; try { m = JSON.parse(d); } catch (e) { return; } if (m && typeof m === 'object') onMsg(ws, m); });
  ws.on('close', () => {
    const r = rooms.get(ws.room), p = r && r.players.get(ws.pid);
    if (!p || p.ws !== ws) return;
    p.ws = null; r.last = Date.now();
    if (r.phase === 'lobby') r.players.delete(p.id);
    if (r.host === p.id) { const n = [...r.players.values()].find(x => x.ws); if (n) r.host = n.id; }
    if (!r.players.size) { clearTimeout(r.timer); rooms.delete(r.code); return; }
    bc(r, pub(r)); checkAll(r);
  });
});
setInterval(() => wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }), 25000);
setInterval(() => rooms.forEach((r, c) => {
  if (Date.now() - r.last > 600000 && ![...r.players.values()].some(p => p.ws)) { clearTimeout(r.timer); rooms.delete(c); }
}), 60000);
server.listen(PORT, () => console.log('Quiz en ligne sur le port ' + PORT + ' (' + Q.length + ' questions)'));
