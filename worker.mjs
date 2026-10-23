/* Tchenebrengue · servidor da TV (Cloudflare Workers + Durable Objects)
   Worker : rotas /api/tv, /api/insc, /api/cancel, /api/minhas, /api/replay e /ws
   Canal  : a emissora. Uma só instância: fila de inscrições, pareamento, janela de apostas,
            luta sorteada aqui (sim.mjs), resultado e histórico. Roda por alarme.
   Wallet : carteira por token (reservada; a TV ainda não usa) */
import { cleanStats, runFight, calcOdds } from './sim.mjs';

const BET_MS = 30000, DONE_MS = 14000, KEEP = 12, MAX_PEND = 4, MAX_HIST = 20, MAX_Q = 200;

/* mesmas lutas do site de inscrição; "opp" é o galo da casa quando ninguém mais se inscreve */
const EVENTS = {
  pinto:    { title: 'Copa Pinto de Ouro', fee: 10, prize: 30,  spots: 12, opp: { name: 'Trovão',    pal: 0, atk: 10.3, def: 4.8, spd: 6.3, luck: .08, hp: 94 } },
  terreiro: { title: 'Rinha do Terreiro',  fee: 20, prize: 60,  spots: 8,  opp: { name: 'Capitão',   pal: 1, atk: 11.5, def: 5.5, spd: 7,   luck: .1,  hp: 100 } },
  cangaco:  { title: 'Desafio do Cangaço', fee: 40, prize: 130, spots: 6,  opp: { name: 'Relâmpago', pal: 4, atk: 12.3, def: 6.1, spd: 7.7, luck: .12, hp: 105 } },
  final:    { title: 'Final da Roça',      fee: 80, prize: 280, spots: 4,  opp: { name: 'Sultão',    pal: 5, atk: 14.3, def: 7.4, spd: 8.8, luck: .14, hp: 114 } }
};
/* elenco das exibições (a TV nunca fica vazia) */
const HOUSE = [EVENTS.pinto.opp, EVENTS.terreiro.opp, EVENTS.cangaco.opp, EVENTS.final.opp,
  { name: 'Faísca',   pal: 2, atk: 11,   def: 5,   spd: 7.4, luck: .1, hp: 98 },
  { name: 'Valentão', pal: 3, atk: 11.8, def: 5.8, spd: 6.8, luck: .1, hp: 102 }];

const cors = () => ({ 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' });
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
const clean = (s, n) => String(s || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, n);
const nickOf = s => clean(s, 14) || 'Anônimo';
const nameOf = s => clean(s, 16) || 'Galo';
const okToken = t => typeof t === 'string' && t.length >= 20 && t.length <= 80;
const sha = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
const hexColor = v => Number.isInteger(v) && v >= 0 && v <= 0xffffff ? v : 0x888888;
const cleanPal = p => { p = p || {}; const o = {}; for (const k of ['body', 'dark', 'gold', 'wing', 't1', 't2', 't3', 'hud']) o[k] = hexColor(p[k]); if (p.thin) { o.thin = p.thin === 2 ? 2 : true; o.skin = hexColor(p.skin); } if (p.mustache) o.mustache = true; return o; };
const pub = s => ({ nick: s.nick, name: s.name, pal: s.pal, st: s.st, bot: !!s.bot });
const house = (o, avoid) => {
  const pal = o.pal === avoid ? [0, 1, 2, 3, 4, 5].find(p => p !== avoid && p !== o.pal) : o.pal;
  return { bot: 1, nick: 'Galo da casa', name: o.name, pal, pid: pal, st: cleanStats(o) };
};

const originOk = (req, env) => {
  const allowed = (env.ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean), o = req.headers.get('Origin');
  return !(allowed.length && o && !allowed.includes(o));
};

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors() });
    const canal = () => env.CANAL.get(env.CANAL.idFromName('tv'));
    if (u.pathname === '/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('use websocket', { status: 426 });
      if (!originOk(req, env)) return new Response('origem não permitida', { status: 403 });
      return canal().fetch(req);
    }
    if (u.pathname.startsWith('/api/')) {
      if (req.method === 'POST' && !originOk(req, env)) return new Response(JSON.stringify({ ok: false, error: 'origem não permitida' }), { status: 403, headers: { 'content-type': 'application/json', ...cors() } });
      const r = await canal().fetch(req);
      return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json', ...cors() } });
    }
    return new Response('Tchenebrengue TV', { headers: cors() });
  }
};

/* ---------- carteira (reservada) ---------- */
export class Wallet {
  constructor(state) { this.s = state.storage; }
  async fetch(req) {
    const b = await req.json().catch(() => ({}));
    let c = await this.s.get('c'); if (c == null) c = 100;
    if (b.op === 'add') {
      const a = Math.round(Number(b.amt) || 0);
      if (c + a < 0) return json({ ok: false, coins: c });
      c += a;
    } else if (c < 10) c = 30;
    await this.s.put('c', c);
    return json({ ok: true, coins: c });
  }
}

/* ---------- a emissora ----------
   fases: idle (ninguém assistindo nem na fila) → bet (30 s) → fight → done (14 s) → bet ...
   S.q   : inscrições esperando (ordem de chegada)
   S.cur : luta atual { id, ev, seats[2], odds, seed }
   u:<dono> : histórico de inscrições de cada jogador (só guardamos o hash do token) */
export class Canal {
  constructor(state, env) {
    this.st = state; this.env = env; this.lastPush = 0; this.memo = null;
    this.S = { phase: 'idle', deadline: 0, fid: 0, qn: 0, q: [], cur: null, recent: [], rank: {} };
    state.blockConcurrencyWhile(async () => { const s = await state.storage.get('S'); if (s) this.S = s; });
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  save() { return this.st.storage.put('S', this.S); }
  viewers(ex) { return this.st.getWebSockets().filter(w => w !== ex && w.readyState === 1).length; }
  sendTo(ws, o) { try { ws.send(JSON.stringify(o)); } catch (_) {} }

  async fetch(req) {
    const u = new URL(req.url), p = u.pathname, post = req.method === 'POST';
    if (p === '/ws') return this.connect(u);
    if (p === '/api/tv') return json(this.view());
    if (p === '/api/minhas') return this.mine(u.searchParams.get('token'));
    if (p === '/api/replay') return this.replay(Number(u.searchParams.get('id')));
    if (p === '/api/insc' && post) return this.insc(await req.json().catch(() => ({})));
    if (p === '/api/cancel' && post) return this.cancel(await req.json().catch(() => ({})));
    return json({ error: 'rota' }, 404);
  }

  /* ----- o que o público vê ----- */
  top() { return Object.values(this.S.rank).sort((a, b) => b.w - a.w || a.l - b.l).slice(0, 5).map(({ nick, w, l }) => ({ nick, w, l })); }
  view() {
    const S = this.S, c = S.cur, queue = {};
    for (const k in EVENTS) queue[k] = 0;
    for (const i of S.q) queue[i.ev]++;
    return {
      phase: S.phase, left: Math.max(0, S.deadline - Date.now()), viewers: this.viewers(), total: S.q.length, queue,
      fight: c ? { id: c.id, ev: c.ev, title: c.ev ? EVENTS[c.ev].title : 'Exibição do Terreiro', odds: c.odds, seats: c.seats.map(pub) } : null,
      recent: S.recent.slice(0, 8).map(r => ({ id: r.id, title: r.title, a: r.seats[0].name, b: r.seats[1].name, w: r.win })),
      top: this.top()
    };
  }
  seatOf(ws) {
    const c = this.S.cur; if (!c) return -1;
    let a; try { a = ws.deserializeAttachment(); } catch (_) {}
    return a && a.own ? c.seats.findIndex(s => s.own === a.own) : -1;
  }
  runOf(c) {
    if (!this.memo || this.memo.id !== c.id) this.memo = { id: c.id, run: runFight(c.seed, c.seats[0].st, c.seats[1].st) };
    return this.memo.run;
  }
  stMsg(ws) { return { t: 'st', ...this.view(), you: this.seatOf(ws) }; }
  fightMsg(ws, late) {
    const c = this.S.cur, run = this.runOf(c);
    return { t: 'fight', id: c.id, late: !!late, odds: c.odds, win: run.win, sc: run.sc, g: c.seats.map(pub), you: this.seatOf(ws) };
  }
  async push(force) {
    const now = Date.now();
    if (!force && now - this.lastPush < 3000) return;
    this.lastPush = now;
    for (const w of this.st.getWebSockets()) this.sendTo(w, this.stMsg(w));
  }

  /* ----- conexão da TV (WebSocket com hibernação) ----- */
  async connect(u) {
    const token = u.searchParams.get('token') || '';
    const own = okToken(token) ? await sha(token) : '';
    const pair = new WebSocketPair(), [client, server] = Object.values(pair);
    this.st.acceptWebSocket(server);
    server.serializeAttachment({ own });
    await this.wake();
    this.sendTo(server, this.stMsg(server));
    if (this.S.phase === 'fight' && this.S.cur) this.sendTo(server, this.fightMsg(server, true));
    await this.push();
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage() {}
  async webSocketClose(ws) { try { ws.close(); } catch (_) {} await this.push(); }
  async webSocketError(ws) { await this.webSocketClose(ws); }

  /* ----- inscrições ----- */
  async userAdd(own, e) {
    const k = 'u:' + own, l = (await this.st.storage.get(k)) || [];
    l.push(e); if (l.length > MAX_HIST) l.splice(0, l.length - MAX_HIST);
    await this.st.storage.put(k, l);
  }
  async userPatch(own, id, patch) {
    const k = 'u:' + own, l = (await this.st.storage.get(k)) || [], e = l.find(x => x.id === id);
    if (e) { Object.assign(e, patch); await this.st.storage.put(k, l); }
  }
  onAir(id) { const c = this.S.cur; return !!(c && c.seats.some(s => s.insc === id)); }

  async insc(b) {
    const S = this.S, ev = EVENTS[b.ev];
    if (!okToken(b.token)) return json({ ok: false, error: 'Identificação inválida.' }, 400);
    if (!ev) return json({ ok: false, error: 'Luta desconhecida.' }, 400);
    const own = await sha(b.token);
    if (S.q.length >= MAX_Q || S.q.filter(i => i.ev === b.ev).length >= ev.spots) return json({ ok: false, error: 'Vagas esgotadas nesta luta. Tente na próxima rodada.' }, 409);
    if (S.q.some(i => i.own === own && i.ev === b.ev)) return json({ ok: false, error: 'Você já está inscrito nesta luta.' }, 409);
    if (S.q.filter(i => i.own === own).length >= MAX_PEND) return json({ ok: false, error: 'Você já tem inscrições demais na fila.' }, 409);
    const g = b.galo || {}, id = ++S.qn;
    const rec = { id, ev: b.ev, own, nick: nickOf(b.owner), name: nameOf(g.name), pal: cleanPal(g.pal), pid: Number.isInteger(g.pid) && g.pid >= 0 && g.pid <= 9 ? g.pid : -1, st: cleanStats(g), t: Date.now() };
    S.q.push(rec); await this.save();
    await this.userAdd(own, { id, ev: b.ev, name: rec.name, fee: ev.fee, prize: ev.prize, st: 'ag', t: rec.t });
    await this.wake(); await this.push(true);
    return json({ ok: true, id, fee: ev.fee, prize: ev.prize });
  }
  async cancel(b) {
    const S = this.S, id = Number(b.id);
    if (!okToken(b.token)) return json({ ok: false, error: 'Identificação inválida.' }, 400);
    const own = await sha(b.token), i = S.q.findIndex(x => x.id === id && x.own === own);
    if (i < 0) return json({ ok: false, error: this.onAir(id) ? 'Seu galo já foi escalado e não pode mais sair.' : 'Inscrição não encontrada.' }, 409);
    const ev = S.q[i].ev; S.q.splice(i, 1); await this.save();
    await this.userPatch(own, id, { st: 'x' }); await this.push(true);
    return json({ ok: true, back: Math.floor(EVENTS[ev].fee / 2) });
  }
  async mine(token) {
    if (!okToken(token)) return json({ ok: false, error: 'token' }, 400);
    const own = await sha(token), l = (await this.st.storage.get('u:' + own)) || [];
    return json({ ok: true, list: l.map(e => ({ ...e, air: e.st === 'ag' && this.onAir(e.id), pos: e.st === 'ag' ? this.S.q.findIndex(x => x.id === e.id) + 1 : 0 })) });
  }
  replay(id) {
    const r = this.S.recent.find(x => x.id === id);
    if (!r) return json({ ok: false, error: 'Replay não está mais guardado.' }, 404);
    const run = runFight(r.seed, r.seats[0].st, r.seats[1].st);
    return json({ ok: true, id, win: run.win, sc: run.sc, g: r.seats, odds: calcOdds(r.seats[0].st, r.seats[1].st) });
  }

  /* ----- programação ----- */
  pairUp() {
    const S = this.S, q = S.q;
    const seat = i => ({ own: i.own, nick: i.nick, name: i.name, pal: i.pal, pid: i.pid, st: i.st, insc: i.id });
    let pr = null;
    outer: for (let i = 0; i < q.length; i++) for (let j = i + 1; j < q.length; j++) if (q[i].ev === q[j].ev && q[i].own !== q[j].own) { pr = [q[i], q[j]]; break outer; }
    if (pr) { S.q = q.filter(x => x !== pr[0] && x !== pr[1]); return { ev: pr[0].ev, list: [seat(pr[0]), seat(pr[1])] }; }
    if (q.length) {
      const a = q.shift(), l = [seat(a), house(EVENTS[a.ev].opp, a.pid)];
      if (Math.random() < .5) l.reverse();
      return { ev: a.ev, list: l };
    }
    const i = Math.floor(Math.random() * HOUSE.length); let j = Math.floor(Math.random() * (HOUSE.length - 1)); if (j >= i) j++;
    return { ev: null, list: [house(HOUSE[i]), house(HOUSE[j])] };
  }
  async wake() { if (this.S.phase === 'idle') await this.next(); }
  async next() {
    const S = this.S;
    if (!S.q.length && this.viewers() === 0) {
      S.phase = 'idle'; S.cur = null; S.deadline = 0;
      await this.st.storage.deleteAlarm(); await this.save(); return this.push(true);
    }
    await this.startBet();
  }
  async startBet() {
    const S = this.S, p = this.pairUp();
    S.fid++; S.cur = { id: S.fid, ev: p.ev, seats: p.list, odds: calcOdds(p.list[0].st, p.list[1].st), seed: 0 };
    S.phase = 'bet'; S.deadline = Date.now() + BET_MS;
    for (let i = 0; i < 2; i++) { const s = p.list[i]; if (s.insc) await this.userPatch(s.own, s.insc, { fid: S.fid, opp: p.list[1 - i].name }); }
    await this.save(); await this.st.storage.setAlarm(S.deadline); await this.push(true);
  }
  async startFight() {
    const S = this.S, c = S.cur;
    c.seed = crypto.getRandomValues(new Uint32Array(1))[0];
    const run = this.runOf(c);
    S.phase = 'fight'; S.deadline = Date.now() + (run.dur + 12) * 1000;
    await this.save(); await this.st.storage.setAlarm(S.deadline);
    for (const w of this.st.getWebSockets()) this.sendTo(w, this.fightMsg(w, false));
    await this.push(true);
  }
  async settle() {
    const S = this.S, c = S.cur, win = this.runOf(c).win;
    for (let i = 0; i < 2; i++) {
      const s = c.seats[i]; if (!s.insc) continue;
      await this.userPatch(s.own, s.insc, { st: i === win ? 'v' : 'd' });
      const r = S.rank[s.own] || (S.rank[s.own] = { nick: s.nick, w: 0, l: 0 });
      r.nick = s.nick; if (i === win) r.w++; else r.l++;
    }
    const keys = Object.keys(S.rank);
    if (keys.length > 200) { keys.sort((a, b) => S.rank[b].w - S.rank[a].w); for (const k of keys.slice(100)) delete S.rank[k]; }
    S.recent.unshift({ id: c.id, title: c.ev ? EVENTS[c.ev].title : 'Exibição do Terreiro', seed: c.seed, seats: c.seats.map(pub), win, t: Date.now() });
    if (S.recent.length > KEEP) S.recent.length = KEEP;
    S.phase = 'done'; S.deadline = Date.now() + DONE_MS;
    await this.save(); await this.st.storage.setAlarm(S.deadline);
    for (const w of this.st.getWebSockets()) this.sendTo(w, { t: 'res', id: c.id, win });
    await this.push(true);
  }
  async alarm() {
    const ph = this.S.phase;
    if (ph === 'bet') await this.startFight();
    else if (ph === 'fight') await this.settle();
    else if (ph === 'done') { this.S.cur = null; await this.next(); }
  }
}
