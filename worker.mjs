/* Chicken Fight · servidor do modo ao vivo (Cloudflare Workers + Durable Objects)
   Worker   : rotas /api/new, /api/rooms, /api/me e /ws
   Room     : uma sala (2 treinadores, plateia, apostas, luta sorteada aqui no servidor)
   Wallet   : saldo de moedas da arena de cada jogador (só o servidor mexe)
   Lobby    : lista de salas abertas */
import { cleanStats, runFight, calcOdds } from './sim.mjs';

const START_COINS = 100, REFILL_BELOW = 10, REFILL_TO = 30;
const BET_MS = 30000, DONE_MS = 14000, MAX_PEOPLE = 40;
const PRIZE_WIN = 30, PRIZE_LOSE = 5, FEE = .05;

const cors = () => ({ 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,OPTIONS', 'access-control-allow-headers': 'content-type' });
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', ...cors() } });
const nickOf = s => String(s || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 14) || 'Anônimo';
const nameOf = s => String(s || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16) || 'Galo';
const CODE = /^[A-Z0-9]{3,8}$/;
const sha = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
const hexColor = v => Number.isInteger(v) && v >= 0 && v <= 0xffffff ? v : 0x888888;
const cleanPal = p => { p = p || {}; const o = {}; for (const k of ['body', 'dark', 'gold', 'wing', 't1', 't2', 't3', 'hud']) o[k] = hexColor(p[k]); if (p.thin) { o.thin = true; o.skin = hexColor(p.skin); } return o; };

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors() });
    if (u.pathname === '/api/rooms') {
      const r = await env.LOBBY.get(env.LOBBY.idFromName('main')).fetch('https://lobby/list');
      return json(await r.json());
    }
    if (u.pathname === '/api/new') {
      const al = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let c = '';
      for (let i = 0; i < 4; i++) c += al[Math.floor(Math.random() * al.length)];
      return json({ code: c });
    }
    if (u.pathname === '/api/me') {
      const t = u.searchParams.get('token') || '';
      if (t.length < 20 || t.length > 80) return json({ error: 'token' }, 400);
      const r = await env.WALLET.get(env.WALLET.idFromName(t)).fetch('https://wallet/', { method: 'POST', body: JSON.stringify({ op: 'get' }) });
      return json(await r.json());
    }
    if (u.pathname === '/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('use websocket', { status: 426 });
      const allowed = (env.ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean), o = req.headers.get('Origin');
      if (allowed.length && o && !allowed.includes(o)) return new Response('origem não permitida', { status: 403 });
      const code = (u.searchParams.get('room') || '').toUpperCase();
      if (!CODE.test(code)) return new Response('sala inválida', { status: 400 });
      return env.ROOM.get(env.ROOM.idFromName(code)).fetch(req);
    }
    return new Response('Chicken Fight live', { headers: cors() });
  }
};

/* ---------- carteira ---------- */
export class Wallet {
  constructor(state) { this.s = state.storage; }
  async fetch(req) {
    const b = await req.json().catch(() => ({}));
    let c = await this.s.get('c'); if (c == null) c = START_COINS;
    if (b.op === 'add') {
      const a = Math.round(Number(b.amt) || 0);
      if (c + a < 0) return json({ ok: false, coins: c });
      c += a;
    } else if (c < REFILL_BELOW) c = REFILL_TO;
    await this.s.put('c', c);
    return json({ ok: true, coins: c });
  }
}

/* ---------- lista de salas ---------- */
export class Lobby {
  constructor() { this.rooms = new Map(); }
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === '/upd') {
      const b = await req.json();
      if (b.gone) this.rooms.delete(b.code); else this.rooms.set(b.code, { ...b, ts: Date.now() });
      return json({ ok: true });
    }
    const now = Date.now(); for (const [k, v] of this.rooms) if (now - v.ts > 60000) this.rooms.delete(k);
    return json({ rooms: [...this.rooms.values()].filter(r => r.viewers > 0).sort((a, b) => b.viewers - a.viewers).slice(0, 20).map(({ code, phase, seats, viewers }) => ({ code, phase, seats, viewers })) });
  }
}

/* ---------- sala ---------- */
export class Room {
  constructor(state, env) {
    this.st = state; this.env = env; this.cl = new Map(); this.lastLobby = 0; this.code = '';
    this.S = { phase: 'wait', seats: [null, null], bets: {}, deadline: 0, run: null, odds: [1.9, 1.9], res: {} };
    state.blockConcurrencyWhile(async () => { const s = await state.storage.get('S'); if (s) this.S = s; });
  }
  save() { return this.st.storage.put('S', this.S); }
  wallet(token) { return this.env.WALLET.get(this.env.WALLET.idFromName(token)); }
  async coinsOf(token, op = 'get', amt = 0) {
    const r = await this.wallet(token).fetch('https://wallet/', { method: 'POST', body: JSON.stringify({ op, amt }) });
    return r.json();
  }
  /* o saldo de quem já saiu da sala precisa do token: guardamos só o hash (id) e o token só na conexão; por isso as apostas ficam com o token do apostador */
  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('use websocket', { status: 426 });
    const u = new URL(req.url), token = u.searchParams.get('token') || '';
    this.code = (u.searchParams.get('room') || '').toUpperCase();
    if (token.length < 20 || token.length > 80) return new Response('token inválido', { status: 400 });
    if (this.cl.size >= MAX_PEOPLE) return new Response('sala cheia', { status: 503 });
    const pair = new WebSocketPair(), [client, server] = Object.values(pair);
    server.accept();
    const id = await sha(token);
    for (const [w, q] of this.cl) if (q.id === id) { this.cl.delete(w); try { w.close(4000, 'aberto em outra aba'); } catch (_) {} }
    const p = { id, nick: nickOf(u.searchParams.get('nick')), token, ws: server, coins: 0 };
    this.cl.set(server, p);
    server.addEventListener('message', e => { this.onMsg(p, e.data).catch(() => {}); });
    const bye = () => { this.onClose(server).catch(() => {}); };
    server.addEventListener('close', bye); server.addEventListener('error', bye);
    const w = await this.coinsOf(token); p.coins = w.coins;
    if (this.S.phase === 'fight' && this.S.run) this.send(p, this.fightMsg(true));
    await this.push();
    return new Response(null, { status: 101, webSocket: client });
  }

  send(p, o) { try { p.ws.send(JSON.stringify(o)); } catch (_) {} }
  seatOf(id) { return this.S.seats.findIndex(s => s && s.id === id); }
  online(id) { for (const q of this.cl.values()) if (q.id === id) return true; return false; }

  async push() {
    const S = this.S, pot = [0, 0];
    for (const b of Object.values(S.bets)) pot[b.side] += b.amt;
    const seats = S.seats.map(s => s && { nick: s.nick, name: s.name, st: s.st });
    for (const p of this.cl.values()) {
      const seat = this.seatOf(p.id), b = S.bets[p.id];
      this.send(p, { t: 'st', code: this.code, phase: S.phase, left: Math.max(0, S.deadline - Date.now()), seats, viewers: this.cl.size, odds: S.odds, pot, you: { coins: p.coins, seat, bet: b ? { side: b.side, amt: b.amt } : null } });
    }
    const now = Date.now();
    if (now - this.lastLobby > 3000 || this.cl.size === 0) {
      this.lastLobby = now;
      const body = this.cl.size ? { code: this.code, phase: S.phase, seats: S.seats.map(s => s ? s.nick : null), viewers: this.cl.size } : { code: this.code, gone: 1 };
      try { await this.env.LOBBY.get(this.env.LOBBY.idFromName('main')).fetch('https://lobby/upd', { method: 'POST', body: JSON.stringify(body) }); } catch (_) {}
    }
  }

  async onMsg(p, raw) {
    if (typeof raw !== 'string' || raw.length > 2500) return;
    let m; try { m = JSON.parse(raw); } catch (_) { return; }
    const S = this.S, err = t => this.send(p, { t: 'err', m: t });
    if (m.t === 'ping') return this.send(p, { t: 'pong' });
    if (m.t === 'sit') {
      if (S.phase !== 'wait') return err('A luta já vai começar. Espere a próxima.');
      if (this.seatOf(p.id) >= 0) return err('Você já está sentado.');
      if (S.bets[p.id]) return err('Quem apostou não pode lutar.');
      const slot = m.slot === 1 ? 1 : 0, i = S.seats[slot] ? 1 - slot : slot;
      if (S.seats[i]) return err('As duas vagas estão ocupadas.');
      const g = m.galo || {};
      S.seats[i] = { id: p.id, nick: p.nick, name: nameOf(g.name), pal: cleanPal(g.pal), st: cleanStats(g) };
      if (S.seats[0] && S.seats[1]) await this.startBet(); else { await this.save(); await this.push(); }
    } else if (m.t === 'stand') {
      const i = this.seatOf(p.id);
      if (i < 0) return;
      if (S.phase === 'wait') { S.seats[i] = null; await this.save(); await this.push(); }
      else if (S.phase === 'bet') { S.seats[i] = null; await this.cancelBet(); }
    } else if (m.t === 'bet') {
      if (S.phase !== 'bet') return err('As apostas não estão abertas.');
      if (this.seatOf(p.id) >= 0) return err('Treinador não aposta.');
      const side = m.side === 1 ? 1 : 0, amt = Math.floor(Number(m.amt));
      const old = S.bets[p.id] ? S.bets[p.id].amt : 0, cap = Math.max(5, Math.floor((p.coins + old) * .5));
      if (!(amt >= 5)) return err('Aposta mínima: 5 moedas.');
      if (amt > cap) return err('Máximo: ' + cap + ' (metade do saldo).');
      const w = await this.coinsOf(p.token, 'add', old - amt);
      if (!w.ok) return err('Saldo insuficiente.');
      if (this.S.phase !== 'bet') { const back = await this.coinsOf(p.token, 'add', amt - old); p.coins = back.coins; await this.push(); return err('As apostas fecharam.'); }
      p.coins = w.coins; S.bets[p.id] = { side, amt, token: p.token };
      await this.save(); await this.push();
    } else if (m.t === 'unbet') {
      const b = S.bets[p.id];
      if (S.phase !== 'bet' || !b) return;
      delete S.bets[p.id];
      const w = await this.coinsOf(p.token, 'add', b.amt); p.coins = w.coins;
      await this.save(); await this.push();
    }
  }

  async onClose(ws) {
    const p = this.cl.get(ws); if (!p) return;
    this.cl.delete(ws);
    const i = this.seatOf(p.id);
    if (i >= 0 && !this.online(p.id)) {
      if (this.S.phase === 'wait') this.S.seats[i] = null;
      else if (this.S.phase === 'bet') { this.S.seats[i] = null; return this.cancelBet(); }
    }
    if (this.S.phase === 'bet' && this.S.bets[p.id] && !this.online(p.id)) { /* apostas de quem saiu continuam valendo */ }
    await this.save(); await this.push();
  }

  async startBet() {
    const S = this.S; S.phase = 'bet'; S.bets = {}; S.res = {}; S.run = null;
    S.odds = calcOdds(S.seats[0].st, S.seats[1].st); S.deadline = Date.now() + BET_MS;
    await this.save(); await this.st.storage.setAlarm(S.deadline); await this.push();
  }
  async cancelBet() {
    const S = this.S;
    for (const b of Object.values(S.bets)) await this.coinsOf(b.token, 'add', b.amt);
    S.bets = {}; S.phase = 'wait'; S.deadline = 0;
    await this.st.storage.deleteAlarm();
    for (const p of this.cl.values()) p.coins = (await this.coinsOf(p.token)).coins;
    await this.save(); await this.push();
  }
  fightMsg(late) {
    const S = this.S;
    return { t: 'fight', late: !!late, odds: S.odds, win: S.run.win, sc: S.run.sc, g: S.seats.map(s => ({ nick: s.nick, name: s.name, pal: s.pal, st: s.st })) };
  }
  async startFight() {
    const S = this.S;
    if (!(S.seats[0] && S.seats[1])) { S.phase = 'wait'; await this.save(); return this.push(); }
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    S.run = runFight(seed, S.seats[0].st, S.seats[1].st); S.phase = 'fight'; S.deadline = Date.now() + (S.run.dur + 14) * 1000;
    await this.save(); await this.st.storage.setAlarm(S.deadline);
    const m = this.fightMsg(false); for (const p of this.cl.values()) this.send(p, m);
    await this.push();
  }
  async settle() {
    const S = this.S, win = S.run.win, res = {};
    for (const [id, b] of Object.entries(S.bets)) {
      if (b.side === win) {
        const net = Math.round(b.amt * (S.odds[win] - 1)), fee = Math.ceil(net * FEE);
        await this.coinsOf(b.token, 'add', b.amt + net - fee); res[id] = net - fee;
      } else res[id] = -b.amt;
    }
    for (let i = 0; i < 2; i++) { const s = S.seats[i]; if (!s) continue; const tk = [...this.cl.values()].find(q => q.id === s.id); if (tk) { await this.coinsOf(tk.token, 'add', i === win ? PRIZE_WIN : PRIZE_LOSE); res[s.id] = (res[s.id] || 0) + (i === win ? PRIZE_WIN : PRIZE_LOSE); } }
    S.res = res; S.phase = 'done'; S.deadline = Date.now() + DONE_MS; await this.save(); await this.st.storage.setAlarm(S.deadline);
    for (const p of this.cl.values()) { p.coins = (await this.coinsOf(p.token)).coins; this.send(p, { t: 'res', win, delta: res[p.id] || 0, bet: !!S.bets[p.id], coins: p.coins }); }
    await this.push();
  }
  async afterDone() {
    const S = this.S;
    S.seats = S.seats.map(s => s && this.online(s.id) ? s : null); S.bets = {}; S.run = null;
    if (S.seats[0] && S.seats[1]) return this.startBet();
    S.phase = 'wait'; S.deadline = 0; await this.save(); await this.push();
  }
  async alarm() {
    const ph = this.S.phase;
    if (ph === 'bet') await this.startFight(); else if (ph === 'fight') await this.settle(); else if (ph === 'done') await this.afterDone();
  }
}
