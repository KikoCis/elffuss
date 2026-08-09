#!/usr/bin/env node
/**
 * Fact-recall benchmark for context packers.
 *
 * WHAT IT MEASURES, and why it is built this way:
 *
 * Agent sessions are generated over a REAL project — every tool result is the
 * genuine output of reading, listing or searching real files, not synthetic
 * text. Halfway through the session the agent read a definition. At the end it
 * is asked about it. The benchmark's only question is:
 *
 *     is that definition still inside the packed context?
 *
 * There is NO model judging. It is a presence check: deterministic and
 * reproducible. That matters more than it looks: scoring the SAME answers,
 * three different judges gave us 0%, ~100% and something measurable, depending
 * on the model and the prompt. A benchmark whose result depends on which judge
 * you pick is no use for deciding between two packers.
 *
 * Every condition gets the SAME token budget. The only thing that changes is
 * the selection policy.
 *
 * USAGE
 *   node run.mjs --root <path-to-a-repo> [--ext .js] [--budget 3000]
 *                [--seeds 8] [--packer <file.js>]
 *
 * --packer must export `packHistory(history, budgetTokens)`. By default it uses
 * this repository's own core, so the README numbers reproduce with nothing to
 * configure.
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
  console.error('missing --root <path-to-a-repo>.  E.g.: node run.mjs --root ../core --ext .js');
  process.exit(2);
}

// The core reads flags from localStorage, which does not exist in Node. It is
// given an empty stand-in: that way the benchmark measures the DEFAULT
// behaviour, which is what has to be measured — not some configuration
// somebody left switched on.
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

// CONDITIONS. `tail` is the bar that has to be cleared: keep the last messages
// until the budget is full and throw away the rest. If a packer does not beat
// this, everything else you measure about it is beside the point.
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

console.log(`\n  ${ROOT}  ·  ${sessions} sessions  ·  budget ${BUDGET} tokens\n`);
console.log(`  ${'condition'.padEnd(12)}${'recall'.padStart(10)}${'tokens'.padStart(10)}`);
for (const [name, a] of Object.entries(acc)) {
  if (!a.n) continue;
  console.log(`  ${name.padEnd(12)}${(100 * a.hit / a.n).toFixed(1).padStart(9)}%${Math.round(a.tok / a.n).toString().padStart(10)}`);
}
console.log(`\n  n = ${acc.packer.n} probes\n`);
