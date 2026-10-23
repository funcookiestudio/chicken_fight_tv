/* Teste local do Canal (sem Cloudflare): node teste.mjs */
globalThis.Response = class { constructor(b, i = {}) { this.body = b; this.status = i.status ?? 200; this.webSocket = i.webSocket; } async json() { return JSON.parse(this.body); } };
globalThis.WebSocketRequestResponsePair = class {};
class Sock {
  constructor() { this.got = []; this.att = null; this.readyState = 1; this.peer = null; }
  send(m) { if (this.peer) this.peer.got.push(JSON.parse(m)); }
  serializeAttachment(a) { this.att = a; } deserializeAttachment() { return this.att; }
  close() { this.readyState = 3; }
}
globalThis.WebSocketPair = class { constructor() { const c = new Sock(), s = new Sock(); c.peer = s; s.peer = c; this[0] = c; this[1] = s; } };
const { Canal } = await import('./worker.mjs');

const socks = []; let alarm = null; const mem = new Map();
const state = {
  storage: { get: async k => mem.get(k), put: async (k, v) => { mem.set(k, structuredClone(v)); }, setAlarm: async t => { alarm = t; }, deleteAlarm: async () => { alarm = null; } },
  blockConcurrencyWhile: async f => f(), acceptWebSocket: ws => socks.push(ws), getWebSockets: () => socks.filter(s => s.readyState === 1), setWebSocketAutoResponse() {}
};
const canal = new Canal(state, {});
let ok = true; const check = (c, m) => { console.log((c ? 'ok   ' : 'FALHA') + ' ' + m); if (!c) ok = false; };
const tk = n => n.padEnd(24, 'x');
const call = (path, method = 'GET', body) => canal.fetch({ url: 'https://x' + path, method, json: async () => body, headers: { get: () => null } }).then(r => r.json());
const join = async n => { const r = await canal.fetch({ url: 'https://x/ws?token=' + tk(n), method: 'GET', headers: { get: () => null } }); return r.webSocket; };
const last = (c, t) => [...c.got].reverse().find(m => m.t === t);
const galo = (name, atk = 11.5) => ({ name, pid: 1, atk, def: 5.5, spd: 7, luck: .1, hp: 100, pal: { body: 0xb8431a, dark: 1, gold: 2, wing: 3, t1: 4, t2: 5, t3: 6, hud: 0xf0993f } });
const insc = (n, ev, name) => call('/api/insc', 'POST', { token: tk(n), ev, owner: n, galo: galo(name) });
const step = async () => { await canal.alarm(); };   // avança uma fase

/* 1. TV vazia: quem conecta acorda a emissora com uma exibição */
check(canal.S.phase === 'idle', 'começa parada');
const A = await join('Ana');
check(canal.S.phase === 'bet' && canal.S.cur.ev === null && canal.S.cur.seats.every(s => s.bot), 'ao conectar abre apostas com exibição casa x casa');
check(last(A, 'st').fight.seats.length === 2 && alarm > Date.now() + 25000, 'espectador recebe a luta e o alarme fica em ~30 s');

/* 2. validações */
check(!(await call('/api/insc', 'POST', { token: 'curto', ev: 'pinto' })).ok, 'token curto recusado');
check(!(await insc('Beto', 'nao-existe', 'Galo')).ok, 'luta desconhecida recusada');
const r1 = await insc('Beto', 'pinto', 'Trovão');
check(r1.ok && r1.fee === 10 && r1.prize === 30, 'inscrição aceita com taxa e prêmio do servidor');
check(!(await insc('Beto', 'pinto', 'Trovão')).ok, 'segunda inscrição na mesma luta recusada');
check(last(A, 'st').queue.pinto === 1 && last(A, 'st').total === 1, 'fila atualizada para a plateia');

/* 3. exibição termina; a inscrição de Beto vira luta contra a casa */
await step();
const f0 = last(A, 'fight');
check(f0 && f0.sc.length > 3 && (f0.win === 0 || f0.win === 1) && canal.S.phase === 'fight', 'luta sorteada e enviada');
await step();
check(last(A, 'res') && canal.S.phase === 'done' && canal.S.recent.length === 1, 'resultado enviado e guardado no histórico');
await step();
check(canal.S.phase === 'bet' && canal.S.cur.seats.some(s => s.insc === r1.id) && canal.S.cur.seats.some(s => s.bot), 'inscrito é escalado contra um galo da casa');
check(canal.S.cur.seats.find(s => s.bot).pal !== 1, 'galo da casa não repete a cor do galo do jogador');
let m = await call('/api/minhas?token=' + tk('Beto'));
check(m.list[0].st === 'ag' && m.list[0].air === true && m.list[0].opp, 'minhas inscrições: escalada, com adversário');
const rc = await call('/api/cancel', 'POST', { token: tk('Beto'), id: r1.id });
check(!rc.ok, 'quem já foi escalado não consegue cancelar');
await step(); await step();
m = await call('/api/minhas?token=' + tk('Beto'));
check(m.list[0].st === 'v' || m.list[0].st === 'd', 'resultado aparece em minhas inscrições (' + m.list[0].st + ')');
check(canal.S.rank[Object.keys(canal.S.rank)[0]].w + canal.S.rank[Object.keys(canal.S.rank)[0]].l === 1, 'ranking registrou a luta');

/* 4. dois jogadores na mesma luta se enfrentam */
await step();   // done -> bet
const c1 = await insc('Caio', 'terreiro', 'Faísca'), d1 = await insc('Duda', 'terreiro', 'Mourão'), e1 = await insc('Eva', 'final', 'Tufão');
check(c1.ok && d1.ok && e1.ok, 'três inscrições novas');
const canc = await call('/api/cancel', 'POST', { token: tk('Eva'), id: e1.id });
check(canc.ok && canc.back === 40, 'cancelar antes de ser escalado devolve metade da taxa');
check(!(await call('/api/cancel', 'POST', { token: tk('Eva'), id: e1.id })).ok, 'cancelar de novo dá erro');
await step(); await step(); await step();   // fight, done, nova bet
const cur = canal.S.cur;
check(cur.ev === 'terreiro' && cur.seats.every(s => s.insc && !s.bot), 'Caio x Duda se enfrentam, sem galo da casa');
check(last(A, 'st').fight.seats.every(s => !('own' in s)), 'identificador do dono não vai para a plateia');

/* 5. replay */
const id = canal.S.recent[0].id, rp = await call('/api/replay?id=' + id);
check(rp.ok && rp.sc.length > 3 && rp.win === canal.S.recent[0].win, 'replay refaz a mesma luta pela semente');
check(!(await call('/api/replay?id=9999')).ok, 'replay inexistente dá erro');

/* 6. sem plateia e sem fila a emissora para */
socks.forEach(s => { s.readyState = 3; });
for (let i = 0; i < 6 && canal.S.phase !== 'idle'; i++) await step();
check(canal.S.phase === 'idle' && alarm === null, 'sem ninguém assistindo nem na fila, a emissora para e solta o alarme');
const B2 = await join('Fabio');
check(canal.S.phase === 'bet', 'novo espectador acorda a emissora');

console.log(ok ? '\nTUDO CERTO' : '\nHÁ FALHAS'); process.exit(ok ? 0 : 1);
