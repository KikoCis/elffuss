// Elffuss Code skills: markdown instructions (Claude Code's SKILL.md format)
// that the model follows when they apply. They install from the big OFFICIAL
// catalogue (github.com/anthropics/skills), from the official plugins, or from
// ANY public repo (community marketplaces such as OpenClaude/openclaw).
// Everything is transparent: you see the repo, the list, and the SKILL.md that
// gets injected. They are stored in IndexedDB (nothing leaves the browser).
import * as db from './db.js';

const KEY = 'skills';          // installed skills
const SRC_KEY = 'skills.sources'; // custom repos added by the user
const MAX_SKILL = 12_000;      // characters of the body injected into the model

export const CATALOG_REPO = 'anthropics/skills';
export const DEFAULT_SOURCES = [
  { repo: 'bbgnsurftech/claude-skills-collection', label: 'Comunidad · Mega-colección (1000+ skills)', official: true },
  { repo: 'anthropics/skills', label: 'Anthropic · Agent Skills (oficial de Claude Code)', official: true },
  { repo: 'anthropics/claude-plugins-official', label: 'Anthropic · Claude Code Plugins (oficial)', official: true },
];

let cache = []; // installed, in memory (so that systemPrompt can be synchronous)

// `loaded` tells "there are no skills" apart from "we could not read them". A
// transient IndexedDB failure used to leave the cache empty, and the next
// install() then persisted that emptiness — wiping every installed skill.
let loaded = false;
export async function initSkills() {
  try {
    const stored = await db.get('kv', KEY);
    cache = Array.isArray(stored) ? stored : [];
    loaded = true;
  } catch (e) {
    cache = [];
    loaded = false;
    console.warn('[elffuss] could not read skills; refusing to overwrite them', e);
  }
  return cache;
}
export function skillsLoaded() { return loaded; }

export async function all() { return cache; }
export function installed() { return cache; }
export function isInstalled(repo, path) { return cache.some(s => s.repo === repo && s.path === path); }

export async function install(skill) {
  // If the initial read failed, `cache` does not represent what is installed:
  // retry before writing, and refuse rather than destroy.
  if (!loaded) {
    await initSkills();
    if (!loaded) throw new Error('Could not read your saved skills; not installing, so none are lost. Reload and try again.');
  }
  cache = cache.filter(s => !(s.repo === skill.repo && s.path === skill.path) && s.name !== skill.name);
  const entry = { ...skill, content: (skill.content || '').slice(0, MAX_SKILL) };
  cache.push(entry);
  await db.set('kv', KEY, cache);
  return entry;                       // returns the full skill (name, description…)
}

// "How to use it" message after installing: what it does + an example of what
// to ask for. The returned copy is user-facing and stays in Spanish.
export function usageMessage(skill) {
  const desc = (skill.description || '').trim();
  const ejemplo = firstExample(skill) || `algo relacionado con «${skill.name}»`;
  return `✳ **Skill «${skill.name}» instalada.**\n\n` +
    (desc ? desc + '\n\n' : '') +
    `Ya la sigo en cada conversación. Para usarla, pídeme por ejemplo:\n\n> ${ejemplo}`;
}

// Tries to pull a usage example out of the SKILL.md body (example/usage lines).
function firstExample(skill) {
  const body = skill.content || '';
  const m = body.match(/(?:ejemplo|example|uso|usage|prueba|try)[^\n:]*[:：]\s*["“]?([^\n"”]{6,90})/i)
    || body.match(/^[-*]\s+([A-ZÁÉÍÓÚ][^\n]{10,80})/m);
  return m ? m[1].trim().replace(/[.*_`]+$/, '') : null;
}

export async function remove(nameOrPath) {
  cache = cache.filter(s => s.name !== nameOrPath && s.path !== nameOrPath);
  await db.set('kv', KEY, cache);
}

export async function get(name) {
  return cache.find(s => s.name.toLowerCase() === String(name).toLowerCase()) || null;
}

// ---- sources (repos) ----
export async function sources() {
  const custom = (await db.get('kv', SRC_KEY).catch(() => null)) || [];
  return [...DEFAULT_SOURCES, ...custom];
}
export async function addSource(repoOrUrl, label) {
  const repo = repoOrUrl.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Usa owner/repo (o la URL de GitHub)');
  const custom = (await db.get('kv', SRC_KEY).catch(() => null)) || [];
  if (!custom.some(s => s.repo === repo) && !DEFAULT_SOURCES.some(s => s.repo === repo))
    custom.push({ repo, label: label || repo });
  await db.set('kv', SRC_KEY, custom);
  return repo;
}
export async function removeSource(repo) {
  const custom = (await db.get('kv', SRC_KEY).catch(() => null)) || [];
  await db.set('kv', SRC_KEY, custom.filter(s => s.repo !== repo));
}

// ---- catalogue from GitHub ----
// A single call to the repo's git tree → every SKILL.md.
export async function listFromRepo(repo) {
  let tree, branch;
  for (const b of ['main', 'master']) {
    const r = await fetch(`https://api.github.com/repos/${repo}/git/trees/${b}?recursive=1`);
    if (r.ok) { tree = await r.json(); branch = b; break; }
    if (r.status === 403) throw new Error('GitHub limitó las peticiones (60/h sin login). Reintenta en unos minutos.');
  }
  if (!tree) throw new Error('No pude leer el repo (¿existe y es público?)');
  return (tree.tree || [])
    .filter(n => /(^|\/)SKILL\.md$/i.test(n.path))
    .map(n => ({ repo, branch, path: n.path, dir: n.path.replace(/\/SKILL\.md$/i, ''), name: n.path.replace(/\/SKILL\.md$/i, '').split('/').pop() || repo }))
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

// Downloads the SKILL.md and installs it (simple YAML frontmatter).
export async function installFromRepo(entry) {
  let md = null;
  for (const b of [entry.branch, 'main', 'master'].filter(Boolean)) {
    const r = await fetch(`https://raw.githubusercontent.com/${entry.repo}/${b}/${entry.path}`);
    if (r.ok) { md = await r.text(); break; }
  }
  if (md == null) throw new Error('No pude descargar el SKILL.md');
  const skill = parseSkill(md, entry.name);
  return install({ ...skill, repo: entry.repo, path: entry.path });
}

// SKILL.md → { name, description, content }
export function parseSkill(md, fallbackName = 'skill') {
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  const meta = fm?.[1] || '';
  const name = meta.match(/^name:\s*(.+)$/m)?.[1]?.trim() || fallbackName;
  const description = (meta.match(/^description:\s*([\s\S]+?)(?:\n\w+:|$)/m)?.[1] || '').replace(/\s+/g, ' ').trim();
  const content = md.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  return { name, description, content };
}

// Skill maker: Elffuss builds a skill of its own (SKILL.md) out of whatever the
// user wants, and installs it instantly. It shows up in the Skills tab and is
// injected into the prompt of the following turns.
export async function createSkill({ name, description, instructions } = {}) {
  if (!name || !instructions) throw new Error('Faltan name o instructions');
  const skill = {
    name: String(name).slice(0, 48),
    description: (description || '').slice(0, 240),
    content: String(instructions).slice(0, MAX_SKILL),
    repo: 'creada por Elffuss',
    path: 'local/' + Date.now(),
  };
  await install(skill);
  return `Skill «${skill.name}» creada e instalada. Ya la sigo en cada conversación (mírala en la pestaña Skills).`;
}

// Block for the systemPrompt (synchronous, straight from the cache). The
// injected wording is prompt content, not documentation: it stays in Spanish.
export function skillsPromptBlock() {
  if (!cache.length) return '';
  const parts = cache.map(s =>
    `### Skill «${s.name}»${s.repo ? ` (de ${s.repo})` : ''}\n${s.description || ''}\n${(s.content || '').slice(0, MAX_SKILL)}`);
  return `\n\nSKILLS ACTIVAS (instrucciones especializadas; síguelas cuando la tarea encaje):\n${parts.join('\n\n')}`;
}
