// Autonomous CEO brain (shared by Elffuss Code and Elffuss Claw): when the user
// is NOT asking for anything (idle) and a local model is loaded, the elf "works
// on her own" — she surveys the workspace, splits the work across several
// profiles that think IN PARALLEL (each one a line of thought in the Mind view)
// and synthesises improvement proposals.
//
// Deliberately tool-agnostic: each app injects its own workspace adapter
// (`init({ workspace, ... })`) — Code uses code.js (a code project), Claw uses
// fs.js (folders with permission). The core neither knows nor cares which.
//
// Safety: it does NOT modify your files. It leaves the proposals in an additive
// folder (it never touches what already exists) and makes them "float" in the
// Mind. It STOPS the moment it detects user activity and resumes once things
// are idle again.
import { Agent } from './agent.js';
import { humanizeTool } from './humanize.js';

const IDLE_MS = 18000;       // no activity for this long → the CEO starts working
const TICK_MS = 3000;        // how often we check
// Five minutes between automatic cycles: on a much shorter cooldown, one idle
// afternoon generated THOUSANDS of files. "Think now" (forceCycle) is still
// available without waiting for this.
const COOLDOWN_MS = 300000;
const SOUL_CAP = 25;          // loose files before consolidating into archivo.md

// default profile if the host app does not supply its own
const GENERIC_PROFILES = [
  { id: 'p1', name: 'Revisión', focus: 'qué mejorar de forma concreta y accionable', color: '#7c5cff' },
  { id: 'p2', name: 'Calidad', focus: 'errores, casos borde, cosas que podrían fallar', color: '#49e8ff' },
];

const slug = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 24) || 'perfil';

// ── namespace (localStorage) and workspace adapter: supplied by the host app ──
let NS = 'elffuss';           // prefix for the localStorage keys
let ws = null;                // { isReady, tree, write, read, list, remove }
let getProvider = () => null;
let isBusy = () => false;     // does the user have work queued/in flight? → priority
let defaultProfiles = GENERIC_PROFILES;
const K = suffix => NS + '.' + suffix;

function loadProfiles() {
  try { const s = JSON.parse(localStorage.getItem(K('ceoProfiles'))); if (Array.isArray(s) && s.length) return s; } catch { /* */ }
  return defaultProfiles.map(p => ({ ...p }));
}
let profiles = null;
export function getProfiles() { if (!profiles) profiles = loadProfiles(); return profiles; }
export function setProfiles(list) {
  const used = new Set();
  profiles = (list || []).filter(p => p && p.name).map(p => {
    let id = p.id || slug(p.name); let n = id, i = 2;
    while (used.has(n)) n = id + '-' + i++;
    used.add(n);
    return { id: n, name: String(p.name).slice(0, 40), focus: String(p.focus || '').slice(0, 200), color: /^#[0-9a-f]{6}$/i.test(p.color || '') ? p.color : '#7c5cff' };
  });
  if (!profiles.length) profiles = defaultProfiles.map(p => ({ ...p }));
  try { localStorage.setItem(K('ceoProfiles'), JSON.stringify(profiles)); } catch { /* */ }
  emit('ceo', { type: 'reprogram', text: 'Perfiles actualizados: ' + profiles.map(p => p.name).join(', '), profiles });
  return profiles;
}

let enabled = false, running = false, lastActivity = Date.now(), timer = null, lastCycleEnd = 0, cycleN = 0;

// Reprogrammable MISSION: the user can re-aim the brain from the Mind view
// ("focus on security", "optimise my spreadsheets", "document everything"…).
let DEFAULT_MISSION = 'Revisar el espacio de trabajo y proponer mejoras concretas y accionables.';
let mission = null;
function ensureMission() { if (mission == null) { try { mission = localStorage.getItem(K('ceoMission')) || DEFAULT_MISSION; } catch { mission = DEFAULT_MISSION; } } }
export function getMission() { ensureMission(); return mission; }
export function setMission(text) {
  mission = (text || '').trim() || DEFAULT_MISSION;
  try { localStorage.setItem(K('ceoMission'), mission); } catch { /* */ }
  emit('ceo', { type: 'reprogram', text: 'Nueva misión recibida: ' + mission });
  lastCycleEnd = 0; lastActivity = Date.now() - IDLE_MS; // start a cycle soon with the new mission
  return mission;
}

// "Soul" folder where the brain creates and stores EVERYTHING (configurable).
let DEFAULT_SOUL = '.elffuss/soul';
let soulDir = null;
function ensureSoulDir() { if (soulDir == null) { try { soulDir = localStorage.getItem(K('ceoDir')) || DEFAULT_SOUL; } catch { soulDir = DEFAULT_SOUL; } } }
export function getSoulDir() { ensureSoulDir(); return soulDir; }
export function setSoulDir(dir) {
  soulDir = (dir || '').trim().replace(/^\/+|\/+$/g, '') || DEFAULT_SOUL;
  try { localStorage.setItem(K('ceoDir'), soulDir); } catch { /* */ }
  emit('ceo', { type: 'reprogram', text: 'Nueva carpeta-alma: ' + soulDir + '/' });
  return soulDir;
}

// ── cross-tab semaphore: ONE brain runs, ALL tabs display ──────────────────
// The leader holds an exclusive Web Lock (released on its own when the tab is
// closed); it broadcasts its thoughts over BroadcastChannel so the rest can see
// them. (Isolated per origin by the browser itself: Code and Claw never cross.)
let isLeader = false, bc = null, realEmit = () => {}, crossTabWired = false;
function initCrossTab() {
  if (crossTabWired) return;
  crossTabWired = true;
  try {
    bc = new BroadcastChannel(NS + '-ceo');
    bc.onmessage = e => { if (e.data && e.data.kind === 'thought') realEmit(e.data.channel, e.data.ev); };
  } catch { /* no BroadcastChannel */ }
  if (navigator.locks && navigator.locks.request) {
    navigator.locks.request(NS + '-ceo-leader', { mode: 'exclusive' }, () => new Promise(() => { isLeader = true; }))
      .catch(() => { isLeader = true; });
  } else { isLeader = true; }
}
function emit(channel, ev) {
  realEmit(channel, ev);
  try { bc && bc.postMessage({ kind: 'thought', channel, ev }); } catch { /* ev not serialisable */ }
}

// init({ workspace, provider, onEvent, isBusy, namespace, defaultProfiles, defaultMission, defaultSoulDir })
export function init(opts = {}) {
  if (opts.workspace) ws = opts.workspace;
  if (opts.provider) getProvider = opts.provider;
  if (opts.onEvent) realEmit = opts.onEvent;
  if (opts.isBusy) isBusy = opts.isBusy;
  if (opts.namespace) NS = opts.namespace;
  if (opts.defaultProfiles) defaultProfiles = opts.defaultProfiles;
  if (opts.defaultMission) DEFAULT_MISSION = opts.defaultMission;
  if (opts.defaultSoulDir) DEFAULT_SOUL = opts.defaultSoulDir;
  initCrossTab();
}
export function isThisTabLeader() { return isLeader; }
export function noteActivity() { lastActivity = Date.now(); if (running) running = 'interrupt'; }
export function isEnabled() { return enabled; }
export function isRunning() { return !!running; }
// Play/stop: persisted HERE (single source) — any button that touches it stays
// in sync, and the choice survives a page reload.
export function wasEnabledLastSession() { try { return localStorage.getItem(K('ceoEnabled')) === '1'; } catch { return false; } }
// did the user ever actually decide (play or stop)? This tells "never touched
// it" apart from "paused it on purpose" — only the first should auto-enable
// when the Mind is opened; the second must be RESPECTED, not overridden.
export function hasDecided() { try { return localStorage.getItem(K('ceoEnabled')) != null; } catch { return false; } }
export function enable() {
  if (enabled) return;
  enabled = true; lastActivity = Date.now(); schedule();
  try { localStorage.setItem(K('ceoEnabled'), '1'); } catch { /* */ }
  emit('sys', { type: 'status', text: 'CEO en guardia — trabajaré cuando estés ocioso' });
}
export function disable() {
  enabled = false; running = false; if (timer) clearTimeout(timer);
  try { localStorage.setItem(K('ceoEnabled'), '0'); } catch { /* */ }
  emit('sys', { type: 'status', text: 'CEO en pausa' });
}

function schedule() { if (timer) clearTimeout(timer); timer = setTimeout(tick, TICK_MS); }

// "Think now" — skips the idle wait. It still respects the semaphore: if
// another tab is the leader, it does not compete for the accelerator.
export async function forceCycle() {
  if (!isLeader) { emit('ceo', { type: 'paused', text: 'Otra pestaña lleva el cerebro — ábrela ahí para forzar un ciclo.' }); return false; }
  if (running) return false;
  // isReady() may be sync (Code: handle in memory) or async (Claw: queries IndexedDB) — always awaited.
  if (!(await ws?.isReady()) || !getProvider()) { emit('ceo', { type: 'paused', text: 'Necesito un espacio de trabajo abierto y un modelo cargado.' }); return false; }
  try { await runCycle(); } finally { lastCycleEnd = Date.now(); }
  return true;
}

async function tick() {
  if (!enabled) return;
  const idle = Date.now() - lastActivity;
  const rested = Date.now() - lastCycleEnd > COOLDOWN_MS;
  const mightRun = isLeader && !running && !isBusy() && idle >= IDLE_MS && rested && getProvider();
  if (mightRun && await ws?.isReady()) {
    try { await runCycle(); } catch { /* next cycle */ }
    lastCycleEnd = Date.now();
  }
  schedule();
}

// helper: runs the agent with the current provider over a prompt, emitting
// tokens/tools to a channel. Returns the final text. Tool calls ALWAYS go
// through the same runTool the normal chat uses (the real Agent.handle).
async function think(channel, task) {
  const prov = getProvider();
  if (!prov) return '';
  const a = new Agent({ chat: (h, s, cb) => prov.chat(h, s, cb) });
  let out = '';
  await a.handle(task, ev => {
    if (running === 'interrupt') throw new Error('interrumpido');
    if (ev.type === 'token') { out += ev.text; emit(channel, { type: 'token', text: ev.text }); }
    else if (ev.type === 'tool') emit(channel, { type: 'tool', text: humanizeTool(ev.call.tool, ev.call.args), tool: ev.call.tool, path: ev.call.args?.path || null });
    else if (ev.type === 'tool_result') emit(channel, { type: 'tool_result', tool: ev.tool, text: String(ev.result || '').replace(/\s+/g, ' ').trim().slice(0, 100) });
    else if (ev.type === 'text') { out = ev.text; }
  });
  return out;
}

async function runCycle() {
  running = true;
  cycleN++;
  emit('ceo', { type: 'cycle', n: cycleN, text: 'Nuevo ciclo: reviso el espacio de trabajo y reparto el trabajo…' });

  let tree = '';
  try { tree = await ws.tree({ depth: 2 }); } catch { /* no workspace */ }
  emit('ceo', { type: 'survey', text: 'Panorama captado (' + tree.split('\n').length + ' entradas). Delegando…' });

  const brief = (d) => `MISIÓN del equipo (fijada por el usuario): ${getMission()}\n` +
    `Eres el jefe de ${d.name}. Dentro de esa misión, céntrate en: ${d.focus}. ` +
    `Explora lo mínimo con tus herramientas y propón UNA mejora CONCRETA y accionable, ` +
    `entendible por un humano. Sé breve. No modifiques nada existente: solo la propuesta.`;
  const proposals = await Promise.all(getProfiles().map(async d => {
    emit(d.id, { type: 'open', name: d.name, focus: d.focus });
    try { const p = await think(d.id, brief(d)); emit(d.id, { type: 'done', text: p }); return { dept: d.name, text: p }; }
    catch { emit(d.id, { type: 'done', text: '(interrumpido)' }); return null; }
  }));
  if (running === 'interrupt') { running = false; emit('ceo', { type: 'paused', text: 'Vuelves tú — dejo lo mío y te cedo el mando.' }); return; }

  const valid = proposals.filter(Boolean).filter(p => p.text && p.text.length > 8);
  const md = `# Propuestas de mejora — ciclo ${cycleN}\n\n**Misión:** ${getMission()}\n\n` +
    valid.map(p => `## ${p.dept}\n${p.text}\n`).join('\n') +
    `\n_— generado por el cerebro CEO de Elffuss mientras estabas ocioso._\n`;
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  const topic = slug((valid[0]?.text || 'ciclo').split(/[.,;\n]/)[0]) || 'ciclo';
  const path = `${getSoulDir()}/${stamp}-${topic}.md`;
  try {
    await rotateSoul();
    await ws.write({ path, content: md });
    emit('ceo', { type: 'built', text: `Propuesta guardada en ${path}`, path, md, proposals: valid });
  } catch (e) {
    emit('ceo', { type: 'built', text: 'Propuesta lista (no pude escribir el fichero)', md, proposals: valid });
  }
  running = false;
}

// Rotation: if there are too many loose files, the OLDEST ones are consolidated
// into a single archivo.md and deleted — so we do not end up with thousands.
async function rotateSoul() {
  try {
    const soul = getSoulDir();
    const names = (await ws.list(soul)).filter(n => n.endsWith('.md') && n !== 'archivo.md');
    if (names.length < SOUL_CAP) return;
    names.sort(); // the name starts with the date → chronological order
    const excess = names.slice(0, names.length - SOUL_CAP + 1);
    let archive = ''; try { archive = await ws.read({ path: `${soul}/archivo.md` }); } catch { archive = '# Archivo histórico del cerebro\n'; }
    for (const name of excess) {
      try { archive += `\n---\n## ${name}\n${await ws.read({ path: `${soul}/${name}` })}\n`; } catch { /* */ }
    }
    await ws.write({ path: `${soul}/archivo.md`, content: archive.slice(-80000) });
    for (const name of excess) { try { await ws.remove(soul, name); } catch { /* */ } }
    emit('ceo', { type: 'reprogram', text: `Consolidé ${excess.length} propuestas antiguas en archivo.md` });
  } catch { /* soulDir not created yet, or no permission: nothing to rotate */ }
}
