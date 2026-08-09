#!/usr/bin/env node
/**
 * Banco de recuerdo de hechos para empaquetadores de contexto.
 *
 * QUÉ MIDE, y por qué está hecho así:
 *
 * Se generan sesiones de agente sobre un proyecto REAL — cada resultado de
 * herramienta es la salida auténtica de leer, listar o buscar en ficheros de
 * verdad, no texto sintético. A mitad de sesión el agente leyó una definición.
 * Al final se le pregunta por ella. La única pregunta del banco es:
 *
 *     ¿sigue esa definición dentro del contexto empaquetado?
 *
 * NO hay modelo juzgando. Es una comprobación de presencia, determinista y
 * reproducible. Eso importa más de lo que parece: puntuando las MISMAS
 * respuestas, tres jueces distintos nos dieron 0 %, ~100 % y algo medible,
 * según el modelo y el prompt. Un banco cuyo resultado depende de qué juez
 * elijas no sirve para decidir entre dos empaquetadores.
 *
 * Todas las condiciones reciben el MISMO presupuesto de tokens. Lo que cambia
 * es únicamente la política de selección.
 *
 * USO
 *   node run.mjs --root <ruta-de-un-repo> [--ext .js] [--budget 3000]
 *                [--seeds 8] [--packer <fichero.js>]
 *
 * --packer debe exportar `packHistory(history, budgetTokens)`. Por defecto usa
 * el core de este mismo repositorio, así que los números del README se
 * reproducen sin configurar nada.
 */
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SG = require(path.join(HERE, 'sessiongen.js'));

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const ROOT   = arg('root');
const EXT    = arg('ext', '.js');
const BUDGET = parseInt(arg('budget', '3000'), 10);
const SEEDS  = parseInt(arg('seeds', '8'), 10);
const PACKER = path.resolve(arg('packer', path.join(HERE, '..', 'core', 'context.js')));

if (!ROOT) {
  console.error('falta --root <ruta-de-un-repo>.  Ej: node run.mjs --root ../core --ext .js');
  process.exit(2);
}

// El core lee banderas de localStorage, que en Node no existe. Se le da un
// sustituto vacío: así el banco mide el comportamiento POR DEFECTO, que es lo
// que hay que medir — no una configuración que alguien dejó puesta.
if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: k => mem.delete(k),
  };
}

const { packHistory } = await import('file://' + PACKER);
const estTok = s => Math.ceil((s || '').length / 4) + 4;

// CONDICIONES. `tail` es el listón que hay que batir: quedarse los últimos
// mensajes hasta llenar el presupuesto y tirar el resto. Si un empaquetador no
// le gana a esto, todo lo demás que midas de él da igual.
const tail = (history, budget) => {
  const out = []; let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const t = estTok(history[i].content);
    if (used + t > budget) break;
    out.unshift(history[i]); used += t;
  }
  return out.length ? out : [history[history.length - 1]];
};

const CONDS = {
  full:   h => h,
  tail:   h => tail(h, BUDGET),
  packer: h => packHistory(h, BUDGET),
};

const acc = {}; for (const c of Object.keys(CONDS)) acc[c] = { hit: 0, n: 0, tok: 0 };
let sessions = 0;

for (let seed = 1; seed <= SEEDS; seed++) {
  const s = SG.buildSession({ root: ROOT, seed: seed * 7919, steps: 26, exts: [EXT] });
  const probes = SG.selectProbes(s, SG.mulberry32(seed * 104729), 8, 'old', 'ident');
  if (probes.length < 3) continue;
  sessions++;
  for (const p of probes) {
    const h = [...s.history, { role: 'user', content: p.query }];
    for (const [name, fn] of Object.entries(CONDS)) {
      const out = await fn(h, BUDGET);
      const txt = out.map(m => m.content).join('\n');
      acc[name].n++;
      acc[name].tok += out.reduce((a, m) => a + estTok(m.content), 0);
      if (txt.includes(p.ident) && txt.includes(p.value)) acc[name].hit++;
    }
  }
}

console.log(`\n  ${ROOT}  ·  ${sessions} sesiones  ·  presupuesto ${BUDGET} tokens\n`);
console.log(`  ${'condición'.padEnd(12)}${'recuerdo'.padStart(10)}${'tokens'.padStart(10)}`);
for (const [name, a] of Object.entries(acc)) {
  if (!a.n) continue;
  console.log(`  ${name.padEnd(12)}${(100 * a.hit / a.n).toFixed(1).padStart(9)}%${Math.round(a.tok / a.n).toString().padStart(10)}`);
}
console.log(`\n  n = ${acc.packer.n} sondas\n`);
