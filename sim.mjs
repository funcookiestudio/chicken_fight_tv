/* Simulação da luta, sem gráficos. É a mesma regra do nextTurn() do jogo, com sorteio por semente (seed).
   O servidor roda isto; o celular só anima a lista de golpes que recebe. */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? clamp(v, lo, hi) : d; };

/* limites dos atributos: o celular manda os números do galo, o servidor segura os exageros */
export function cleanStats(g = {}) {
  return {
    hp: Math.round(num(g.hp, 50, 160, 100)), atk: num(g.atk, 4, 26, 11.5), def: num(g.def, 1, 16, 5.5),
    spd: num(g.spd, 2, 16, 7), luck: num(g.luck, .02, .3, .1), cw: num(g.cw, 1, 1.6, 1), w: num(g.w, 1.5, 3.6, 2.4)
  };
}

export function mulberry32(a) {
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

export function calcOdds(A, B) {
  const pw = f => f.hp * f.atk * (1 + f.spd / 25) * (1 + f.def / 30), a = pw(A), c = pw(B);
  return [clamp(.92 * (a + c) / a, 1.15, 6), clamp(.92 * (a + c) / c, 1.15, 6)].map(x => Math.round(x * 100) / 100);
}

const K = { peck: [.7, 0, 6], kick: [1, .04, 12], fly: [1.3, .16, 18], clinch: [.85, 0, 10], flurry: [1.6, .04, 22] };

export function runFight(seed, sa, sb) {
  const rnd = mulberry32(seed >>> 0);
  const F = [sa, sb].map(s => ({ hp: s.hp, max: s.hp, atk: s.atk, def: s.def, spd: s.spd, luck: s.luck, cw: s.cw || 1, en: 100, rg2: 0 }));
  const sc = []; let cnt = null, lastAtt = null, streak = 0, dur = 0, win = -1;
  for (let turnN = 0; turnN < 150 && win < 0; turnN++) {
    const [A, B] = F;
    F.forEach(f => { f.en = Math.min(100, f.en + 6); if (f.hp < f.max * .25 && !f.rg2) f.rg2 = 1; });
    const spdOf = f => f.spd * (.6 + .4 * f.en / 100);
    let att = cnt || (rnd() < spdOf(A) / (spdOf(A) + spdOf(B)) ? A : B);
    if (!cnt && att === lastAtt && streak >= 2 && rnd() < .6) att = att === A ? B : A;
    const def = att === A ? B : A, ctr = cnt === att; cnt = null;
    streak = att === lastAtt ? streak + 1 : 1; lastAtt = att;
    const tired = att.en < 30, r = rnd();
    let kind = ctr ? (r < .6 ? 'kick' : 'peck') : tired ? (r < .5 ? 'peck' : r < .8 ? 'clinch' : 'kick') : r < .1 ? 'clinch' : r < .24 ? 'fly' : r < .4 ? 'peck' : 'kick';
    const miss = rnd() < .06 + K[kind][1] + Math.max(0, def.spd - att.spd) * .012 + (tired ? .08 : 0) - (def.en < 30 ? .08 : 0);
    let dmg = 0, crit = false;
    if (!miss) {
      const rage = att.hp < att.max * .25 ? 1.25 : 1;
      dmg = Math.max(2, att.atk * rage * K[kind][0] * (.75 + rnd() * .5) * (ctr ? 1.2 : 1) - def.def * .4 * (def.en < 30 ? .6 : 1));
      crit = rnd() < att.luck + (rage > 1 ? .06 : 0) + (ctr ? .06 : 0);
      if (crit) { dmg *= 1.6; kind = 'flurry'; }
      dmg = Math.round(dmg);
    }
    att.en = Math.max(0, att.en - K[kind][2] * att.cw);
    if (miss && rnd() < .5) cnt = def;
    const isK = kind === 'kick' || kind === 'flurry', n = kind === 'flurry' ? 3 : 1 + Math.floor(rnd() * 3);
    dur += isK ? 2.3 + .2 * n : 2.3;
    const rec = { a: att === A ? 0 : 1, k: kind, m: miss ? 1 : 0, d: dmg, c: crit ? 1 : 0, n, x: ctr ? 1 : 0, cn: cnt ? 1 : 0, en: [Math.round(A.en * 10) / 10, Math.round(B.en * 10) / 10] };
    /* a pegada de peito tira fôlego de quem apanhou; o celular aplica o mesmo no momento do golpe, por isso o registro guarda o fôlego antes disso */
    def.hp = Math.max(0, def.hp - dmg);
    if (!miss && kind === 'clinch') def.en = Math.max(0, def.en - 14);
    rec.hp = [A.hp, B.hp];
    sc.push(rec);
    if (def.hp <= 0) win = att === A ? 0 : 1;
  }
  if (win < 0) win = F[0].hp >= F[1].hp ? 0 : 1;
  return { sc, win, dur: Math.round(dur * 10) / 10 };
}
