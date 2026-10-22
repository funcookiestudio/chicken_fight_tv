/* Teste local do fluxo da sala (sem Cloudflare): node teste.mjs */
globalThis.Response = class { constructor(b, i = {}) { this.body = b; this.status = i.status ?? 200; this.webSocket = i.webSocket; } async json() { return JSON.parse(this.body); } };
class Sock {
  constructor() { this.l = {}; this.peer = null; this.got = []; }
  accept() {} addEventListener(t, f) { (this.l[t] ||= []).push(f); }
  send(m) { if (this.peer) { this.peer.got.push(JSON.parse(m)); } }
  emit(m) { (this.peer.l.message || []).forEach(f => f({ data: JSON.stringify(m) })); }
  close() { (this.peer.l.close || []).forEach(f => f()); }
}
globalThis.WebSocketPair = class { constructor() { const a = new Sock(), b = new Sock(); a.peer = b; b.peer = a; this[0] = b; this[1] = a; } };
const { Room, Wallet, Lobby } = await import('./worker.mjs');
const mkState = () => { const m = new Map(); let alarm = null; return { alarm: () => alarm, storage: { get: async k => m.get(k), put: async (k, v) => { m.set(k, structuredClone(v)); }, setAlarm: async t => { alarm = t; }, deleteAlarm: async () => { alarm = null; } }, blockConcurrencyWhile: async f => f() }; };
const ns = cls => { const inst = new Map(); return { idFromName: n => n, get: id => ({ fetch: async (u, init = {}) => { if (!inst.has(id)) inst.set(id, new cls(mkState(), env)); return inst.get(id).fetch({ url: u, method: init.method, json: async () => JSON.parse(init.body || '{}') }); } }) }; };
const env = {}; env.WALLET = ns(Wallet); env.LOBBY = ns(Lobby);
const state = mkState(); const room = new Room(state, env); env.ROOM = null;
let ok = true; const check = (c, m) => { console.log((c ? 'ok   ' : 'FALHA') + ' ' + m); if (!c) ok = false; };
const join = async (tk, nick) => { const r = await room.fetch({ headers: { get: k => k === 'Upgrade' ? 'websocket' : null }, url: 'https://x/ws?room=TEST&token=' + tk.padEnd(24, 'x') + '&nick=' + nick }); return r.webSocket; };
const last = (c, t) => [...c.got].reverse().find(m => m.t === t);
const galo = (name, atk) => ({ name, atk, def: 5.5, spd: 7, luck: .1, hp: 100, pal: { body: 0xb8431a, dark: 1, gold: 2, wing: 3, t1: 4, t2: 5, t3: 6, hud: 0xf0993f } });

const A = await join('tokenA', 'Ana'), B = await join('tokenB', 'Beto'), C = await join('tokenC', 'Caio'), D = await join('tokenD', 'Duda');
check(last(C, 'st').you.coins === 100, 'carteira nova começa com 100');
A.emit({ t: 'sit', slot: 0, galo: galo('Trovão', 12) });
B.emit({ t: 'sit', slot: 1, galo: galo('Capitão', 11) });
await new Promise(r => setTimeout(r, 30));
check(last(C, 'st').phase === 'bet', 'com dois treinadores abre a janela de apostas');
check(state.alarm() > Date.now() + 25000, 'alarme marcado para ~30s');
C.emit({ t: 'bet', side: 0, amt: 20 }); D.emit({ t: 'bet', side: 1, amt: 10 }); C.emit({ t: 'bet', side: 0, amt: 90 });
await new Promise(r => setTimeout(r, 30));
check(last(C, 'st').you.coins === 80 && last(C, 'st').you.bet.amt === 20, 'aposta de 20 debitada; aposta acima de metade do saldo recusada');
check(last(C, 'err'), 'erro enviado ao apostador');
A.emit({ t: 'bet', side: 1, amt: 10 }); await new Promise(r => setTimeout(r, 30));
check(last(A, 'err') && !room.S.bets[Object.keys(room.S.bets).find(k => k === room.S.seats[0].id)], 'treinador não consegue apostar');
await room.alarm();
const f = last(C, 'fight');
check(f && f.sc.length > 3 && (f.win === 0 || f.win === 1) && f.g[0].name === 'Trovão', 'luta enviada para toda a sala');
check(last(A, 'fight') && last(D, 'fight'), 'todos recebem a mesma luta');
await room.alarm();
const rc = last(C, 'res'), rd = last(D, 'res'), ra = last(A, 'res'), rb = last(B, 'res');
console.log('   vencedor', f.win, '| Caio', rc.delta, rc.coins, '| Duda', rd.delta, rd.coins, '| Ana', ra.delta, '| Beto', rb.delta);
check(f.win === 0 ? rc.delta > 0 && rd.delta === -10 : rd.delta > 0 && rc.delta === -20, 'apostas pagas/perdidas conforme o vencedor');
check(f.win === 0 ? ra.delta === 30 && rb.delta === 5 : rb.delta === 30 && ra.delta === 5, 'prêmio dos treinadores');
check(room.S.phase === 'done', 'fase "done" depois do pagamento');
await room.alarm();
check(room.S.phase === 'bet', 'treinadores seguem sentados: nova rodada de apostas abre sozinha');
D.emit({ t: 'bet', side: 0, amt: 6 }); await new Promise(r => setTimeout(r, 30));
const before = last(D, 'st').you.coins;
A.emit({ t: 'stand' }); await new Promise(r => setTimeout(r, 30));
check(room.S.phase === 'wait' && last(D, 'st').you.coins === before + 6, 'treinador que levanta cancela a rodada e devolve as apostas');
console.log(ok ? '\nTUDO CERTO' : '\nHÁ FALHAS'); process.exit(ok ? 0 : 1);
