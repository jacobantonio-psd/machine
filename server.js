// Machine Party LAN - zero-dependency server. Run: node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
const PORT = process.env.PORT || 3000;

const srv = http.createServer((q, r) => {
  r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  r.end(fs.readFileSync(path.join(__dirname, 'index.html')));
});

// ---- minimal WebSocket (text frames only) ----
srv.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) return sock.destroy();
  const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  const c = { sock, id: crypto.randomBytes(3).toString('hex'), buf: Buffer.alloc(0) };
  sock.on('data', d => {
    c.buf = Buffer.concat([c.buf, d]);
    let f; while ((f = frame(c))) {
      if (f.op === 8) { sock.end(); return; }
      if (f.op === 1) { try { onMsg(c, JSON.parse(f.p.toString())); } catch (e) { } }
    }
  });
  sock.on('close', () => drop(c));
  sock.on('error', () => { });
});
function frame(c) {
  const b = c.buf; if (b.length < 2) return null;
  const op = b[0] & 15; let len = b[1] & 127, o = 2;
  if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); o = 4; }
  else if (len === 127) { if (b.length < 10) return null; len = Number(b.readBigUInt64BE(2)); o = 10; }
  const masked = b[1] & 128, need = o + (masked ? 4 : 0) + len;
  if (b.length < need) return null;
  let p = b.slice(o + (masked ? 4 : 0), need);
  if (masked) { const m = b.slice(o, o + 4); p = Buffer.from(p.map((x, i) => x ^ m[i % 4])); }
  c.buf = b.slice(need); return { op, p };
}
function send(c, o) {
  const p = Buffer.from(JSON.stringify(o));
  const h = p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 255]);
  if (!c.sock.destroyed) c.sock.write(Buffer.concat([h, p]));
}

// ---- game state ----
const P = new Map(); // id -> client {id,name,hp,sock}
let phase = 'lobby', host = null, G = null, tm = [], round = 0, last = '';
const later = (f, ms) => tm.push(setTimeout(f, ms));
const clearT = () => { tm.forEach(clearTimeout); tm = []; };
const alive = () => [...P.values()].filter(p => p.hp > 0);
const rnd = n => Math.floor(Math.random() * n);

function snap() {
  const s = {
    t: 's', phase, host, round, msg: G ? G.msg : '', win: G ? G.winner : null, game: G ? G.pub : null,
    players: [...P.values()].map(p => ({ id: p.id, name: p.name, hp: p.hp, st: G && G.res[p.id] ? (G.res[p.id].ok ? 'ok' : 'x') : '' }))
  };
  P.forEach(p => send(p, { ...s, you: p.id }));
}

function onMsg(c, m) {
  if (m.t === 'join') {
    if (P.has(c.id)) return;
    if (phase !== 'lobby') return send(c, { t: 'err', m: 'Game in progress. Wait for the next one.' });
    if (P.size >= 4) return send(c, { t: 'err', m: 'Chamber full (4 players).' });
    c.name = String(m.name || 'Subject').trim().slice(0, 12) || 'Subject'; c.hp = 3;
    P.set(c.id, c); host = host || c.id; snap();
  }
  if (!P.has(c.id)) return;
  if (m.t === 'start' && c.id === host && phase === 'lobby' && P.size >= 2) { P.forEach(p => p.hp = 3); round = 0; last = ''; nextRound(); }
  if (m.t === 'in' && phase === 'play' && c.hp > 0 && !G.res[c.id]) G.input(c, m);
  if (m.t === 'shock' && phase === 'shock' && c.id === G.winner) {
    const t = P.get(m.target);
    if (t && t.hp > 0 && t !== c) { t.hp--; G.msg = c.name + ' shocked ' + t.name; clearT(); afterShock(); }
  }
  if (m.t === 'again' && c.id === host && phase === 'over') { phase = 'lobby'; G = null; P.forEach(p => p.hp = 3); snap(); }
}

function drop(c) {
  if (!P.has(c.id)) return;
  P.delete(c.id);
  if (host === c.id) host = [...P.keys()][0] || null;
  if (!P.size) { clearT(); phase = 'lobby'; G = null; return; }
  if (phase === 'lobby') return snap();
  if (alive().length <= 1) { clearT(); finish(); }
  else { snap(); if (phase === 'play') checkAll(); }
}

const GAMES = {
  memory: {
    name: 'PANEL MEMORY', start() {
      const seq = Array.from({ length: 5 }, () => rnd(4)), show = seq.length * 700 + 900;
      G.seq = seq; G.t0 = Date.now() + show; G.prog = {}; G.pub = { type: 'memory' };
      P.forEach(p => send(p, { t: 'mem', seq }));
      later(endRound, show + 12000);
    },
    input(c, m) {
      if (Date.now() < G.t0) return;
      const i = G.prog[c.id] || 0;
      if (G.seq[i] !== m.v) return resolve(c, false);
      G.prog[c.id] = i + 1;
      if (i + 1 === G.seq.length) resolve(c, true, Date.now() - G.t0);
    }
  },
  reaction: {
    name: 'HOLD FIRE', start() {
      G.pub = { type: 'reaction', go: false };
      later(() => { G.t0 = Date.now(); G.pub.go = true; snap(); later(endRound, 2500); }, 2000 + rnd(3000));
    },
    input(c) { G.pub.go ? resolve(c, true, Date.now() - G.t0) : resolve(c, false); }
  },
  tiles: {
    name: 'SAFE TILES', start() {
      G.bombs = new Set(); while (G.bombs.size < 4) G.bombs.add(rnd(12));
      G.pub = { type: 'tiles', taken: {} }; G.n = 0;
      later(endRound, 9000);
    },
    input(c, m) {
      const v = m.v; if (!(v >= 0 && v < 12) || G.pub.taken[v]) return;
      const bomb = G.bombs.has(v); G.pub.taken[v] = { by: c.id, bomb };
      resolve(c, !bomb, G.n++);
    }
  },
  // 2-4 players: lowest mash count fails (ties at the bottom all fail)
  mash: {
    name: 'MASH PIT', start() {
      G.pub = { type: 'mash' }; G.cnt = {};
      later(() => {
        const al = alive(), v = al.map(p => G.cnt[p.id] || 0), lo = Math.min(...v), hi = Math.max(...v);
        al.forEach(p => { const k = G.cnt[p.id] || 0; G.res[p.id] = { ok: lo === hi || k > lo, time: -k }; });
        endRound();
      }, 5000);
    },
    input(c) { G.cnt[c.id] = (G.cnt[c.id] || 0) + 1; }
  },
  // exactly 4 players: 2v2, losing team fails
  tug: {
    min: 4, max: 4, name: 'TUG OF WAR 2v2', start() {
      const al = alive().sort(() => Math.random() - .5), teams = {};
      al.forEach((p, i) => teams[p.id] = i % 2);
      G.cnt = {}; G.pub = { type: 'tug', teams };
      later(() => {
        const s = [0, 0]; alive().forEach(p => s[teams[p.id]] += G.cnt[p.id] || 0);
        alive().forEach(p => G.res[p.id] = { ok: s[0] === s[1] || s[teams[p.id]] > s[1 - teams[p.id]], time: -(G.cnt[p.id] || 0) });
        endRound();
      }, 5000);
    },
    input(c) { G.cnt[c.id] = (G.cnt[c.id] || 0) + 1; }
  },
  // exactly 2 players: shared revolver, 6 chambers, 1 live round
  roulette: {
    min: 2, max: 2, name: 'ROULETTE DUEL', start() {
      G.ids = alive().map(p => p.id); G.live = rnd(6); G.pos = 0;
      G.pub = { type: 'roulette', turn: G.ids[rnd(2)], n: 0, last: '' }; rArm();
    },
    input(c, m) { if (G.pub.turn === c.id) rFire(c.id, m.v === 'foe'); }
  },
  // 3-4 players: pass the bomb, hidden fuse
  potato: {
    min: 3, max: 4, name: 'HOT POTATO', start() {
      const al = alive(); G.pub = { type: 'potato', holder: al[rnd(al.length)].id };
      later(() => { alive().forEach(p => G.res[p.id] = { ok: p.id !== G.pub.holder, time: 0 }); endRound(); }, 4000 + rnd(5000));
    },
    input(c, m) { const t = P.get(m.v); if (c.id === G.pub.holder && t && t.hp > 0 && t !== c) { G.pub.holder = t.id; snap(); } }
  },
  // 3-4 players: pick a side, the majority side fails
  odd: {
    min: 3, max: 4, name: 'ODD ONE OUT', start() { G.pub = { type: 'odd' }; G.pick = {}; later(oddEnd, 7000); },
    input(c, m) {
      if (m.v !== 0 && m.v !== 1) return; G.pick[c.id] = m.v;
      if (Object.keys(G.pick).length === alive().length) later(oddEnd, 500);
    }
  }
};
function rArm() { clearT(); later(() => rFire(G.pub.turn, false), 8000); }
function rFire(shooter, atFoe) {
  if (G.ended) return;
  const foe = G.ids.find(i => i !== shooter), target = atFoe ? foe : shooter;
  if (G.pos === G.live) { G.ids.forEach(i => G.res[i] = { ok: i !== target, time: 0 }); return endRound(); }
  G.pos++; G.pub.n = G.pos; G.pub.turn = foe; G.pub.last = 'click'; snap(); rArm();
}
function oddEnd() {
  if (G.conc) return; G.conc = true;
  const al = alive(), n = [0, 0]; al.forEach(p => { if (p.id in G.pick) n[G.pick[p.id]]++; });
  const bad = n[0] === n[1] ? rnd(2) : n[0] > n[1] ? 0 : 1;
  al.forEach((p, i) => G.res[p.id] = { ok: G.pick[p.id] !== undefined && G.pick[p.id] !== bad, time: i });
  endRound();
}

function nextRound() {
  const n = alive().length, keys = Object.keys(GAMES).filter(k => k !== last && n >= (GAMES[k].min || 2) && n <= (GAMES[k].max || 4)); last = keys[rnd(keys.length)];
  round++; phase = 'intro';
  G = { type: last, res: {}, msg: GAMES[last].name, pub: { type: 'intro' }, input: GAMES[last].input };
  snap(); later(() => { phase = 'play'; G.msg = ''; GAMES[last].start(); snap(); }, 2500);
}
function resolve(c, ok, time = 0) { G.res[c.id] = { ok, time }; snap(); checkAll(); }
function checkAll() { if (!G.ended && alive().every(p => G.res[p.id])) later(endRound, 700); }

function endRound() {
  if (G.ended) return; G.ended = true; clearT();
  const al = alive(), bad = al.filter(p => !G.res[p.id] || !G.res[p.id].ok);
  const good = al.filter(p => G.res[p.id] && G.res[p.id].ok).sort((a, b) => G.res[a.id].time - G.res[b.id].time);
  bad.forEach(p => p.hp--);
  G.winner = good[0] ? good[0].id : null;
  G.msg = bad.length ? 'FAILED: ' + bad.map(p => p.name).join(', ') : 'EVERYONE SURVIVED';
  phase = 'result'; snap();
  later(() => {
    const others = alive().filter(p => p.id !== G.winner);
    if (G.winner && P.get(G.winner).hp > 0 && others.length) {
      phase = 'shock'; G.msg = P.get(G.winner).name + ' WON - CHOOSE WHO GETS SHOCKED'; snap(); later(() => { G.msg = 'NO SHOCK'; afterShock(); }, 7000);
    } else afterShock();
  }, 2500);
}
function afterShock() {
  phase = 'result'; snap();
  later(() => alive().length <= 1 ? finish() : nextRound(), 1800);
}
function finish() {
  const a = alive(); phase = 'over';
  G = { res: {}, pub: null, msg: a.length ? a[0].name + ' SURVIVES' : 'NOBODY SURVIVED' }; snap();
}

srv.listen(PORT, '0.0.0.0', () => {
  console.log('\nMachine Party LAN is running. Players open one of:');
  Object.values(os.networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal)
    .forEach(i => console.log('  http://' + i.address + ':' + PORT));
  console.log('');
});
