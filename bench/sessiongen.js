'use strict';
/**
 * REAL agentic-session generator for Elffuss Code / Elffuss Claw.
 *
 * Not synthetic: every tool result is the REAL output of the REAL tool over a REAL project
 * on disk, formatted byte-for-byte the way elffuss-code/web/js/tools/{index,code}.js and
 * agent.js emit it ("[resultado <tool>]\n<output>", 100-line numbered pages, the
 * "no existe «x»" error text, ...). What is scripted is only the *policy* (which tool the
 * agent calls next) — the part a model would choose — drawn from a seeded RNG so we get many
 * DIFFERENT real sessions and can report mean±sd instead of one lucky run.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'target',
  '.venv', '__pycache__', '.DS_Store']);

function listFiles(root, exts) {
  const out = [];
  (function walk(dir) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => (a.isDirectory() !== b.isDirectory())
      ? (a.isDirectory() ? -1 : 1) : a.name.localeCompare(b.name));
    for (const e of ents) {
      if (IGNORE.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (!exts || exts.some(x => e.name.endsWith(x))) out.push(path.relative(root, p));
    }
  })(root);
  return out;
}

function toolTree(root, depth = 2) {                     // = code.tree
  const out = []; let count = 0;
  (function walk(dir, prefix, d) {
    if (d > depth || count > 350) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => (a.isDirectory() !== b.isDirectory())
      ? (a.isDirectory() ? -1 : 1) : a.name.localeCompare(b.name));
    for (const e of ents) {
      if (IGNORE.has(e.name)) continue;
      if (++count > 350) { out.push(prefix + '…'); return; }
      out.push(prefix + (e.isDirectory() ? '📁 ' : '') + e.name);
      if (e.isDirectory()) walk(path.join(dir, e.name), prefix + '  ', d + 1);
    }
  })(root, '', 1);
  return out.join('\n') || '(vacío)';
}

const MAX_READ = 120000, PAGE_SIZE = 100;
function toolRead(root, rel, { offset, limit, around } = {}) {   // = code.read
  const abs = path.join(root, rel);
  let full;
  try { full = fs.readFileSync(abs, 'utf8'); }
  catch {
    const base = path.basename(rel);
    const hits = listFiles(root).filter(f => path.basename(f) === base).slice(0, 3);
    return { err: true, text: `ERROR: no existe «${rel}» en este proyecto.` +
      (hits.length ? ` ¿Quizá: ${hits.join(' · ')}?` : '') +
      ' Consulta el árbol (code.tree) o busca (code.search) antes de leer.' };
  }
  if (offset == null && limit == null && around == null) {
    const size = fs.statSync(abs).size;
    return { text: full.length > MAX_READ ? full.slice(0, MAX_READ) + `\n… (recortado, ${size} bytes)` : full,
             lines: full.split('\n'), start: 1 };
  }
  const lines = full.split('\n');
  const totalLines = lines.length;
  const size = Math.max(1, Math.min(Math.round(limit) || PAGE_SIZE, 500));
  const start = around != null ? Math.max(1, Math.round(around) - Math.floor(size / 2))
                               : Math.max(1, Math.round(offset) || 1);
  const startIdx = start - 1;
  const slice = lines.slice(startIdx, startIdx + size);
  const endLine = startIdx + slice.length;
  const numbered = slice.map((l, i) => `${start + i}→${l}`).join('\n');
  const more = endLine < totalLines
    ? `\n… quedan líneas ${endLine + 1}-${totalLines} — pide code.read con offset:${endLine + 1} para seguir` : '';
  return { text: numbered + more, lines: slice, start, numbered: true };
}

function toolSearch(root, query, ext = '') {              // = code.search
  const results = []; const q = query.toLowerCase();
  for (const rel of listFiles(root, ext ? [ext] : null)) {
    if (results.length > 80) break;
    let body; try { body = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
    if (body.length > 200000) continue;
    body.split('\n').forEach((l, i) => {
      if (results.length <= 80 && l.toLowerCase().includes(q))
        results.push(`${rel}:${i + 1}: ${l.trim().slice(0, 140)}`);
    });
  }
  return results.length ? results.join('\n') : `Sin resultados para «${query}»`;
}

function toolShell(root, cmd) {                           // = terminal.run (REAL exec)
  try {
    return execSync(cmd, { cwd: root, encoding: 'utf8', timeout: 15000,
      maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd() || '(sin salida)';
  } catch (e) {
    return `ERROR (exit ${e.status}): ${(e.stderr || e.stdout || e.message).toString().trim().slice(0, 500)}`;
  }
}

// ── gold facts: definition lines a later turn will ask for again ────────────
const DEF_RE = [
  /^\s*(?:pub\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=\s*(.+?);?\s*$/,
  /^\s*(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?);?\s*$/,
  /^\s*(?:static)\s+([A-Z_][A-Z0-9_]*)\s*:[^=]+=\s*(.+?);?\s*$/,
];
function extractGolds(rawLines, file) {
  const golds = [];
  for (const raw of rawLines) {
    const line = raw.replace(/^\d+→/, '');
    for (const re of DEF_RE) {
      const m = line.match(re);
      if (!m) continue;
      const ident = m[1];
      const val = m[2].trim().replace(/\s*\/\/.*$/, '').trim();
      if (val.length < 1 || val.length > 60) break;
      const tok = (val.match(/\d[\d_.]*|"[^"]{2,30}"|'[^']{2,30}'/) || [])[0];
      if (!tok || ident.length < 4) break;
      golds.push({ ident, value: tok.replace(/^['"]|['"]$/g, ''), file, line });
      break;
    }
  }
  return golds;
}

const TASKS = [
  'Revisa este proyecto y dime cómo está organizado el manejo de contexto/estado; luego prepara un cambio pequeño y seguro.',
  'Quiero refactorizar la configuración: localiza todas las constantes por defecto y déjalas documentadas en un solo sitio.',
  'Hay un bug: algunos valores por defecto no coinciden con la documentación. Audita el código y propón el arreglo.',
  'Añade un flag para poder desactivar la funcionalidad principal en caliente, sin romper el comportamiento actual.',
  'Necesito entender el flujo de ejecución de punta a punta para poder tocarlo sin romper nada.',
];

function buildSession({ root, seed, steps = 26, exts }) {
  const rng = mulberry32(seed);
  const files = listFiles(root, exts);
  if (!files.length) throw new Error('no files in ' + root);
  const history = [], golds = [], meta = { root, seed, tools: [] };
  const task = pick(rng, TASKS);
  history.push({ role: 'user', content: task });

  const searchTerms = ['const', 'fn ', 'export', 'error', 'config', 'default', 'async', 'return', 'let mut', 'import'];
  const shellCmds = ['ls -la', 'wc -l *', 'git status --short', 'git log --oneline -5',
                     'find . -name "*.rs" -o -name "*.js" | head -20', 'du -sh .'];
  let readIdx = 0;
  const readOrder = [...files].sort(() => rng() - 0.5);

  for (let s = 0; s < steps; s++) {
    let tool, args, out, rawLines = null, srcFile = null;
    const r = rng();
    if (s === 0) { tool = 'code.tree'; args = { depth: 2 }; out = toolTree(root, 2); }
    else if (s === 1) { const t = pick(rng, searchTerms); tool = 'code.search'; args = { query: t }; out = toolSearch(root, t); }
    else if (r < 0.60) {
      const rel = readOrder[readIdx++ % readOrder.length];
      const useOffset = rng() < 0.5;
      const res = useOffset ? toolRead(root, rel, { offset: 1 + Math.floor(rng() * 3) * 100 }) : toolRead(root, rel);
      tool = 'code.read'; args = useOffset ? { path: rel, offset: 1 } : { path: rel };
      out = res.text; rawLines = res.lines || null; srcFile = rel;
    } else if (r < 0.72) { const t = pick(rng, searchTerms); tool = 'code.search'; args = { query: t }; out = toolSearch(root, t); }
    else if (r < 0.84) { const c = pick(rng, shellCmds); tool = 'terminal.run'; args = { command: c }; out = toolShell(root, c); }
    else if (r < 0.92) { tool = 'code.tree'; args = { depth: 2 }; out = toolTree(root, 2); }   // agents DO re-list
    else {
      const rel = pick(rng, files).replace(/\.(rs|js|ts|py)$/, '_v2.$1');
      tool = 'code.read'; args = { path: rel }; out = toolRead(root, rel).text;
    }
    history.push({ role: 'assistant', content:
      `Voy a mirar esto.\n\`\`\`json\n{"tool":"${tool}","args":${JSON.stringify(args)}}\n\`\`\`` });
    history.push({ role: 'user', content: `[resultado ${tool}]\n${out}` });
    meta.tools.push(tool);
    if (rawLines && srcFile) for (const g of extractGolds(rawLines, srcFile)) { g.turn = history.length - 1; golds.push(g); }
  }
  return { history, golds, meta, task };
}

// Probes = the follow-up questions. `qmode` controls how the question refers to the fact:
//   'ident' the question names the identifier  (an agent going back to a symbol it saw)
//   'file'  the question names only the FILE   (harder: no lexical hook on the gold line)
function selectProbes(session, rng, maxProbes = 12, mode = 'old', qmode = 'ident') {
  const byIdent = new Map();
  for (const g of session.golds) {
    if (!byIdent.has(g.ident)) byIdent.set(g.ident, new Set());
    byIdent.get(g.ident).add(g.line.trim());
  }
  const uniq = session.golds.filter(g => byIdent.get(g.ident).size === 1
    && !session.task.includes(g.ident) && !session.task.includes(g.value));
  const seen = new Set(); const cand = [];
  for (const g of uniq) { if (seen.has(g.ident)) continue; seen.add(g.ident); cand.push(g); }
  const oldest = cand.filter(g => g.turn < session.history.length - 14);
  const pool = mode === 'all' ? cand : (oldest.length >= 4 ? oldest : cand);
  const perTurn = new Map(), perFile = new Map(); const chosen = [];
  for (const g of [...pool].sort(() => rng() - 0.5)) {
    const t = perTurn.get(g.turn) || 0, f = perFile.get(g.file) || 0;
    if (t >= 2 || f >= 3) continue;
    perTurn.set(g.turn, t + 1); perFile.set(g.file, f + 1);
    chosen.push(g);
    if (chosen.length >= maxProbes) break;
  }
  const Q_IDENT = [
    (g) => `Vuelve a ${g.ident}: ¿qué valor por defecto tenía y en qué fichero está definido? Lo necesito para el cambio.`,
    (g) => `Necesito editar ${g.ident}. Dime su valor actual exacto y el fichero, no lo adivines.`,
    (g) => `¿Cuál era el valor de ${g.ident}? Cítame la línea del fichero donde se define.`,
  ];
  const Q_FILE = [
    (g) => `Del fichero ${g.file}: enumérame las constantes que definía con su valor exacto.`,
    (g) => `Vuelve a ${g.file}. ¿Qué valores por defecto declaraba? Cítalos tal cual.`,
    (g) => `Necesito los valores por defecto que vimos en ${g.file}, literales.`,
  ];
  const Q = qmode === 'file' ? Q_FILE : Q_IDENT;
  return chosen.map((g, i) => ({ ...g, query: Q[i % Q.length](g) }));
}

module.exports = { buildSession, selectProbes, listFiles, toolTree, toolRead, toolSearch, mulberry32 };
