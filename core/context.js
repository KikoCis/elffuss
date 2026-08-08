// Gestor de contexto: selección del historial por RELEVANCIA frente a la
// pregunta viva. BM25 con IDF endógena + control de redundancia (MMR), y de
// forma opcional una segunda opinión semántica fusionada por rangos.
//
// ── qué cambió respecto de la versión anterior, y por qué ────────────────────
//
// 1. FUERA la lista de parada escrita a mano. Antes había un STOP con ~90
//    palabras castellanas. La IDF ya se calcula sobre el propio historial, así
//    que lo ubicuo recibe peso casi nulo por construcción — sin diccionario y
//    sin saber en qué idioma estamos. Una lista a mano solo sabía castellano:
//    en una sesión de código en inglés no filtraba nada, y en cualquier idioma
//    envejecía. La IDF endógena se adapta a cada conversación.
//
// 2. FUERA el recorte ciego de resultados antiguos. Antes se truncaban a 600
//    caracteres los `[resultado …]` viejos ANTES de puntuarlos. No se puede
//    recuperar lo que se tiró antes de medir si importaba: si la respuesta
//    estaba en el carácter 900, ya no había forma de encontrarla. Ahora se
//    puntúa primero y se recorta después, y por línea.
//
// 3. Granularidad de LÍNEA, no de mensaje. Un resultado de herramienta es
//    mayoritariamente ruido con dos líneas útiles; quedárselo o tirarlo entero
//    desperdicia presupuesto en ambos sentidos.
//
// 4. Control de REDUNDANCIA (MMR). Es lo único que suma por encima de BM25, y
//    poco: +2,4 puntos a escala completa. (Un smoke de 3 semillas decía +8,9;
//    era ruido de semilla. BM25 con IDF endógena hace casi todo el trabajo.)
//
// 5. Las perillas salen de la PRESIÓN medida, no de constantes — ver prepare().
//
// Medido a igual presupuesto de tokens (recall de hechos, sin juez LLM;
// 25 sesiones, 174 sondas):
//     truncar por la cola .........  7,0 %
//     empaquetador anterior ....... 15,1 %
//     este ........................ 65,3 % ± 8,5
//
// El presupuesto es en tokens (~4 chars/token). Los últimos RECENT mensajes se
// conservan literales mientras quepan en su reserva; el resto compite.

const RECENT = 6;
// La reserva de recientes ya no es constante: sale de la presión medida (ver
// prepare). Sin tope, un solo resultado enorme se come el presupuesto entero.
const MAX_MSG_CHARS = 12000;
const MMR_LAMBDA = 0.5;        // penalización por parecerse a lo ya elegido
const MMR_CAND = 600;
const RRF_K = 60;

// Sin lista de parada: de eso se encarga la IDF. Se admiten tokens de 2
// caracteres porque en código los identificadores cortos a veces son justo
// lo que se busca (`fs`, `db`, `id`).
const tokens = s => ((s || '').toLowerCase().match(/[a-záéíóúñü_][\wáéíóúñü./-]{1,}|\d{2,}/g) || []);
const tokEstimate = m => Math.ceil((m.content || '').length / 4) + 4;
const estTok = s => Math.ceil((s || '').length / 4);

function clampMsg(m) {
  const c = m.content || '';
  if (c.length <= MAX_MSG_CHARS) return m;
  const head = Math.floor(MAX_MSG_CHARS * 0.7);
  const tail = MAX_MSG_CHARS - head - 40;
  return { ...m, content: c.slice(0, head) + `\n… [recortado ${c.length - MAX_MSG_CHARS} caracteres] …\n` + c.slice(-tail) };
}

// BM25 con saturación (k1) y normalización por longitud (b). La IDF sale del
// propio corpus que se le pasa — ahí está la gracia.
function buildBM25(docs, k1 = 1.2, b = 0.75) {
  const N = docs.length || 1;
  const df = new Map(), tfs = [];
  let totalLen = 0;
  for (const d of docs) {
    const t = tokens(d), tf = new Map();
    for (const w of t) tf.set(w, (tf.get(w) || 0) + 1);
    tfs.push({ tf, len: t.length });
    totalLen += t.length;
    for (const w of tf.keys()) df.set(w, (df.get(w) || 0) + 1);
  }
  const avgdl = totalLen / N || 1;
  return (i, q) => {
    const { tf, len } = tfs[i];
    if (!len) return 0;
    let s = 0;
    for (const w of q) {
      const f = tf.get(w); if (!f) continue;
      const n = df.get(w) || 0;
      const idf = Math.max(Math.log(1 + (N - n + 0.5) / (n + 0.5)), 1e-6);
      s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * len / avgdl));
    }
    return s;
  };
}

const simTokens = s => new Set(((s || '').toLowerCase().match(/[a-z0-9_./-]{2,}/g) || []));
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0; const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (big.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return (na && nb) ? d / Math.sqrt(na * nb) : 0;
}

// Fusión por rangos: se mezclan POSICIONES, no puntuaciones, así no hay que
// calibrar escalas entre un BM25 sin acotar y un coseno en [-1,1].
function rrf(lists, k = RRF_K) {
  const out = new Map();
  for (const list of lists) list.forEach((id, r) => out.set(id, (out.get(id) || 0) + 1 / (k + r + 1)));
  return out;
}

// Prepara el estado común: reserva de recientes, pregunta viva, líneas y BM25.
function prepare(history, budgetTokens) {
  // PRESIÓN de compresión: qué fracción del historial cabe. Todas las perillas
  // que dependen del régimen salen de aquí, no de constantes — con 200k de
  // historial contra 32k de presupuesto no manda lo mismo que con 5k contra 3k.
  const historyTok = history.reduce((s, m) => s + tokEstimate(m), 0);
  const pressure = Math.max(0, Math.min(1, budgetTokens / (historyTok || 1)));
  // Con holgura conservar los últimos turnos sale barato; con agobio hay que
  // dejarle sitio a la BÚSQUEDA, que es lo que trae la línea de hace 30 turnos.
  const recentFrac = 0.35 + 0.45 * pressure;
  // La recencia solo desempata BAJO PRESIÓN. Medido en un barrido: con agobio
  // (16× de contexto sobre presupuesto) suma +11 puntos, porque casi ninguna
  // línea tiene relevancia y lo nuevo es la única apuesta que queda. Con
  // holgura RESTA −8: ahí gana el orden del documento, que mantiene juntos los
  // tramos, y un fragmento contiguo vale más que líneas nuevas sueltas.
  const recTie = pressure < 0.25;

  const reserve = Math.floor(budgetTokens * recentFrac);
  const recent = []; let used = 0;
  for (let i = history.length - 1, k = 0; i >= 0 && k < RECENT; i--, k++) {
    const m = clampMsg(history[i]), t = tokEstimate(m);
    if (used + t > reserve && recent.length >= 1) break;
    recent.unshift(m); used += t;
  }
  const old = history.slice(0, history.length - recent.length);
  if (!old.length || used >= budgetTokens) return { done: true, recent, used };

  // La pregunta VIVA: el último turno de usuario que no sea un resultado de
  // herramienta. Es contra esto que se puntúa, no contra la tarea inicial —
  // lo relevante cambia en cada turno.
  const query = [...history].reverse().find(m =>
    m.role === 'user' && !(m.content || '').startsWith('[resultado'))?.content || '';

  const items = [];
  old.forEach((m, mi) => (m.content || '').split('\n').forEach((line, li) =>
    items.push({ mi, li, line, first: li === 0 })));

  const score = buildBM25(items.map(it => it.line));
  const q = [...new Set(tokens(query))];
  const nMsg = Math.max(old.length - 1, 1);
  items.forEach((it, i) => { it.bm = score(i, q); it.rec = it.mi / nMsg; });
  return { done: false, recent, old, used, items, query, recTie, pressure };
}

// Selección bajo un único presupuesto global, con MMR, y emisión con marcas de
// omisión para que el modelo sepa que falta algo.
function selectAndEmit(ctx, budgetTokens) {
  const { recent, old, items } = ctx;
  let used = ctx.used;
  const cap = Math.max(40, Math.floor((budgetTokens - used) * 0.5));
  const idOf = it => it.mi * 100000 + it.li;
  const cost = it => Math.min(estTok(it.line), cap) + 1;

  const pool = [...items].sort((a, b) => b.score - a.score);
  const keep = new Set();

  // MMR: al elegir, penalizar el parecido con lo ya elegido. Es lo único que
  // mide por encima de BM25 a secas (+8,9 puntos).
  const cand = pool.slice(0, MMR_CAND);
  const tok = new Map(cand.map(it => [idOf(it), simTokens(it.line)]));
  const maxSim = new Map(cand.map(it => [idOf(it), 0]));
  const byId = new Map(cand.map(it => [idOf(it), it]));
  const remaining = new Set(cand.map(idOf));
  while (remaining.size && used < budgetTokens) {
    let best = null, bestVal = -Infinity;
    for (const id of remaining) {
      const v = byId.get(id).score - MMR_LAMBDA * maxSim.get(id);
      if (v > bestVal) { bestVal = v; best = id; }
    }
    remaining.delete(best);
    const it = byId.get(best), c = cost(it);
    if (used + c > budgetTokens) continue;
    keep.add(best); used += c;
    const bs = tok.get(best);
    for (const id of remaining) maxSim.set(id, Math.max(maxSim.get(id), jaccard(tok.get(id), bs)));
  }
  for (const it of pool) {                       // lo que quede se llena a lo bruto
    const id = idOf(it); if (keep.has(id)) continue;
    const c = cost(it);
    if (used + c > budgetTokens) continue;
    keep.add(id); used += c;
  }

  const packed = [];
  let droppedMsgs = 0;
  old.forEach((m, mi) => {
    const out = []; let skipped = 0;
    (m.content || '').split('\n').forEach((line, li) => {
      if (keep.has(mi * 100000 + li)) {
        if (skipped) { out.push(`  […${skipped} líneas omitidas…]`); skipped = 0; }
        out.push(line.length > cap * 4 ? line.slice(0, cap * 4) + ' …' : line);
      } else skipped++;
    });
    if (skipped && out.length) out.push(`  […${skipped} líneas omitidas…]`);
    if (!out.length) { droppedMsgs++; return; }
    packed.push({ role: m.role, content: out.join('\n') });
  });
  if (droppedMsgs) packed.push({ role: 'user', content: `[…${droppedMsgs} mensajes antiguos omitidos…]` });
  return [...packed, ...recent];
}

/**
 * Empaqueta el historial en `budgetTokens` — vía léxica, síncrona.
 * Es la que se usa por defecto: no necesita modelo, ni red, ni nada.
 */
export function packHistory(history, budgetTokens = 2200) {
  if (!history.length) return history;
  const ctx = prepare(history, budgetTokens);
  if (ctx.done) return ctx.recent;
  const max = ctx.items.reduce((m, it) => Math.max(m, it.bm), 0) || 1;
  for (const it of ctx.items) {
    // Dos estratos separados por 10 — más de lo que la penalización MMR (≤0.5)
    // puede recorrer, así que una línea sin relevancia NUNCA adelanta a una que
    // sí la tiene. Dentro de cada estrato: BM25 arriba, desempate abajo.
    it.score = it.bm > 0 ? 10 + it.bm / max : (ctx.recTie ? it.rec : 0);
    if (it.first) it.score = Math.max(it.score, 0.5);   // cabecera de procedencia
  }
  return selectAndEmit(ctx, budgetTokens);
}

/**
 * Igual, más una segunda opinión SEMÁNTICA fusionada por rangos.
 *
 * `embed(textos) -> vectores`. Se codifica por bloques de líneas, no línea a
 * línea, porque codificar cada línea es prohibitivo y la señal sobrevive al
 * troceado. Si no se pasa `embed`, o si falla, cae limpiamente a la vía léxica.
 *
 * Por qué fusionar y no sustituir: medido, BM25 y los embeddings EMPATAN
 * (0,598 vs 0,596) — lo semántico no es mejor, recupera cosas DISTINTAS. El
 * léxico acierta el identificador exacto; lo semántico, la paráfrasis. Juntos
 * suben a 0,706.
 */
export async function packHistoryAsync(history, budgetTokens = 2200, opts = {}) {
  const { embed, block = 5, cache } = opts;
  if (!history.length) return history;
  if (!embed) return packHistory(history, budgetTokens);
  const ctx = prepare(history, budgetTokens);
  if (ctx.done) return ctx.recent;

  try {
    const blocks = [];
    for (let i = 0; i < ctx.items.length; i += block) {
      blocks.push({ from: i, text: ctx.items.slice(i, i + block).map(x => x.line).join('\n').slice(0, 2000) });
    }
    const enc = cache ? (t => cache.encode(t)) : (t => embed(t));
    const [qv] = await enc([ctx.query.slice(0, 2000)]);
    const bv = await enc(blocks.map(b => b.text));
    blocks.forEach((bl, bi) => {
      const s = cosine(qv, bv[bi]);
      for (let i = bl.from; i < Math.min(bl.from + block, ctx.items.length); i++) ctx.items[i].sem = s;
    });

    const idOf = it => it.mi * 100000 + it.li;
    const byLex = [...ctx.items].sort((a, b) => b.bm - a.bm).map(idOf);
    const bySem = [...ctx.items].sort((a, b) => (b.sem || 0) - (a.sem || 0)).map(idOf);
    const fused = rrf([byLex, bySem]);
    const max = Math.max(...fused.values()) || 1;
    for (const it of ctx.items) {
      const rel = it.bm > 0 || (it.sem || 0) > 0;
      it.score = rel ? 10 + (fused.get(idOf(it)) || 0) / max : (ctx.recTie ? it.rec : 0);
      if (it.first) it.score = Math.max(it.score, 0.5);
    }
    return selectAndEmit(ctx, budgetTokens);
  } catch {
    return packHistory(history, budgetTokens);   // sin modelo, sin red, sin cuota → léxico
  }
}

/**
 * Caché de embeddings por contenido — "pensar al escribir": un texto se
 * codifica UNA vez por sesión aunque reaparezca veinte turnos después.
 */
export function createEmbedCache(embed, max = 4000) {
  const store = new Map();
  return {
    size: () => store.size,
    async encode(texts) {
      const miss = texts.filter(t => !store.has(t));
      if (miss.length) {
        const v = await embed(miss);
        miss.forEach((t, i) => store.set(t, v[i]));
        while (store.size > max) store.delete(store.keys().next().value);
      }
      return texts.map(t => store.get(t));
    },
  };
}
