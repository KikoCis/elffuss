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
// λ y nº de candidatos NO son constantes: ver measureRedundancy() y
// selectAndEmit(). Un λ fijo destruye información buena cuando el material no
// es redundante, y 600 candidatos fijos dejan sin mirar la mayor parte del
// historial en cuanto el presupuesto es grande — que es el caso real.
const RRF_K = 60;

// Sin lista de parada: de eso se encarga la IDF. Se admiten tokens de 2
// caracteres porque en código los identificadores cortos a veces son justo
// lo que se busca (`fs`, `db`, `id`).
const tokens = s => ((s || '').toLowerCase().match(/[a-záéíóúñü_][\wáéíóúñü./-]{1,}|\d{2,}/g) || []);
// Estimador de tokens. `longitud/4` sirve para prosa pero SUBESTIMA mucho el
// código: la puntuación densa (`{`, `=>`, `.`, `(`) son tokens de un carácter.
// Medido, contar solo por longitud hacía que el empaquetador creyera que cabía
// y se pasara ~1,5× del presupuesto — es decir, el «Too many tokens» que este
// fichero existe para evitar. Se toma el MAYOR de las dos estimaciones.
const estTok = s => {
  if (!s) return 0;
  const pieces = (s.match(/\w+|[^\w\s]/g) || []).length;
  return Math.max(Math.ceil(pieces * 1.25), Math.ceil(s.length / 4));
};
const tokEstimate = m => estTok(m.content) + 4;

function clampMsg(m) {
  const c = m.content || '';
  if (c.length <= MAX_MSG_CHARS) return m;
  const head = Math.floor(MAX_MSG_CHARS * 0.7);
  const tail = MAX_MSG_CHARS - head - 40;
  return { ...m, content: c.slice(0, head) + `\n… [recortado ${c.length - MAX_MSG_CHARS} caracteres] …\n` + c.slice(-tail) };
}

// BM25 con saturación (k1) y normalización por longitud (b). La IDF sale del
// propio corpus que se le pasa — ahí está la gracia.
//
// Okapi BM25: Robertson, Walker, Jones, Hancock-Beaulieu & Gatford, «Okapi at
// TREC-3», TREC-3, 1994. Formulación moderna y justificación de k1/b:
// Robertson & Zaragoza, «The Probabilistic Relevance Framework: BM25 and
// Beyond», FnTIR 3(4), 2009 — https://doi.org/10.1561/1500000019
// La IDF viene de Sparck Jones, Journal of Documentation 28(1), 1972: la idea
// de que lo raro informa, que es sobre la que se sostiene todo esto.
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

// Redundancia REAL del material, muestreada. Un historial de resultados de
// herramienta casi idénticos pide penalizar fuerte; una conversación donde cada
// línea es distinta, casi nada — y ahí un λ alto solo tira información buena.
function measureRedundancy(items, sample = 240) {
  if (items.length < 4) return 0;
  const step = Math.max(1, Math.floor(items.length / sample));
  const picked = [];
  for (let i = 0; i < items.length; i += step) picked.push(simTokens(items[i].line));
  let sum = 0, pairs = 0;
  for (let i = 0; i < picked.length; i++)
    for (let j = i + 1; j < Math.min(i + 8, picked.length); j++) { sum += jaccard(picked[i], picked[j]); pairs++; }
  return pairs ? sum / pairs : 0;
}
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

// Fusión por rangos recíprocos (RRF — Cormack, Clarke & Buettcher, SIGIR 2009,
// https://doi.org/10.1145/1571941.1572114): se mezclan POSICIONES, no
// puntuaciones, así no hay que calibrar escalas entre un BM25 sin acotar y un
// coseno en [-1,1].
function rrf(lists, k = RRF_K) {
  const out = new Map();
  for (const list of lists) list.forEach((id, r) => out.set(id, (out.get(id) || 0) + 1 / (k + r + 1)));
  return out;
}

/**
 * CADUCIDAD — el mismo problema que ya resolvimos en el vigilante de carpetas,
 * un piso más arriba.
 *
 * El agente lee un fichero en el turno 3 y lo EDITA en el 20. BM25 recupera las
 * dos versiones y la vieja puntúa igual de alto, porque comparte todo el
 * vocabulario con la nueva. El modelo ve contenido obsoleto sin ninguna señal
 * de que lo es — y eso no es ineficiencia, es INCORRECCIÓN: ninguna cantidad de
 * relevancia arregla que el dato sea falso. Medido con una sonda leer→editar→
 * releer (8 semillas): la versión FALSA sobrevivía 8/8; con esto, 0/8, y la
 * verdadera sigue 8/8, sin coste en recall.
 *
 * El objetivo NO viene en el resultado: sale de la llamada del asistente
 * anterior. Y se DEGRADA, no se borra: si alguien pregunta expresamente qué
 * decía antes, sigue estando. «Esto ya no es cierto» y «esto no existió nunca»
 * son afirmaciones distintas, y solo la primera es verdad.
 */
function markSuperseded(msgs) {
  const lastFor = new Map(), targetOf = new Map();
  for (let i = 0; i < msgs.length; i++) {
    if (!(msgs[i].content || '').startsWith('[resultado')) continue;
    const call = i > 0 ? (msgs[i - 1].content || '') : '';
    const m = call.match(/"tool"\s*:\s*"([^"]+)"[\s\S]{0,200}?"(?:path|file|command)"\s*:\s*"([^"]+)"/);
    if (!m) continue;
    const key = m[1].split('.')[0] + ':' + m[2];
    targetOf.set(i, key); lastFor.set(key, i);
  }
  const stale = new Set();
  for (const [i, key] of targetOf) if (lastFor.get(key) !== i) stale.add(i);
  return stale;
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
  // La cabecera va SIEMPRE, sin puerta: con la ventana elástica dejó de ser
  // cierto que "con holgura el encargo sobrevive solo" — sobrevivía porque
  // rellenábamos hasta el borde. Medido, al dejar de rellenar caía del 100 % al
  // 0 % a presupuesto 16.000. Era un accidente del relleno, no tener sitio.

  // ── RESERVA DE COLA — es un SUELO, no solo un techo ────────────────────────
  // Parar en el primer mensaje que no cabe convierte la reserva en un tope y no
  // en una garantía: medido, con presupuesto 3.000 la cola se quedaba con el
  // 3-5 % en vez del ~38 % reservado, porque UN resultado de herramienta grande
  // en la penúltima posición bloqueaba todo lo anterior. Los últimos turnos son
  // lo que el modelo necesita sí o sí para saber dónde está, y eso no puede
  // depender de que el turno de antes fuera voluminoso.
  // Mientras no se alcance el suelo (10 %), el mensaje que no cabe se TRUNCA
  // por el medio en vez de descartarse. Por encima, comportamiento de siempre.
  const reserve = Math.floor(budgetTokens * recentFrac);
  const floorTok = Math.floor(budgetTokens * 0.10);
  const recent = []; let used = 0;
  for (let i = history.length - 1, k = 0; i >= 0 && k < RECENT; i--, k++) {
    const m = clampMsg(history[i]), t = tokEstimate(m);
    if (used + t <= reserve) { recent.unshift(m); used += t; continue; }
    if (used >= floorTok) break;
    const room = Math.max(40, Math.min(reserve, floorTok) - used - 4);
    if (room < 40) break;
    const c = m.content || '';
    const keep = Math.max(20, room * 2);
    recent.unshift({ ...m, content: c.length <= keep ? c
      : c.slice(0, keep) + `\n… [recortado ${c.length - keep} caracteres] …` });
    used += room + 4;
    if (used >= floorTok) break;
  }
  let old = history.slice(0, history.length - recent.length);
  if (!old.length || used >= budgetTokens) return { done: true, recent, used, head: [] };

  // ── RESERVA DE CABECERA ────────────────────────────────────────────────────
  // Los PRIMEROS mensajes se conservan literales y SIN puntuar, igual que los
  // últimos, y solo bajo presión (misma puerta que la recencia, misma razón).
  //
  // El arranque lleva el ENCARGO: qué hay que hacer, con qué restricciones. El
  // resto de la sesión lo da por sabido, así que nadie lo repite — y sin
  // repeticiones no hay solape léxico con la pregunta de ahora, o sea que BM25
  // no puede rescatarlo por mucho que importe. Es el único contenido que el
  // agente NO puede reconstruir mirando el código.
  //
  // Respaldo externo: es el resultado central de StreamingLLM (Xiao, Tian, Chen,
  // Han & Lewis, ICLR 2024, https://arxiv.org/abs/2309.17453) — los primeros
  // tokens actúan de SUMIDERO de atención y absorben el 45-55 % de la masa.
  // Un recuperador puro no puede ver eso: no es una propiedad del texto, sino
  // de cómo el modelo lo usa.
  //
  // Medido (A/B mismo código, 8 semillas, sonda que pregunta por el encargo a
  // mitad de sesión):
  //     presupuesto  3.000:  el encargo sobrevive   0 % →  100 %
  //     presupuesto 16.000:  el encargo sobrevive 100 % →  100 %
  //     hechos de media sesión: 85,7 % → 85,7 %  ·  91,1 % → 91,1 %
  // O sea: rescata el encargo de nunca a siempre y NO cuesta nada.
  const headReserve = Math.floor(budgetTokens * 0.05);
  const head = []; let headUsed = 0;
  for (let i = 0; i < old.length; i++) {
    const m = clampMsg(old[i]), t = tokEstimate(m);
    if (headUsed + t > headReserve) break;
    head.push(m); headUsed += t;
  }
  old = old.slice(head.length);
  used += headUsed;
  if (!old.length || used >= budgetTokens) return { done: true, recent, used, head };

  // La pregunta VIVA: el último turno de usuario que no sea un resultado de
  // herramienta. Es contra esto que se puntúa, no contra la tarea inicial —
  // lo relevante cambia en cada turno.
  const query = [...history].reverse().find(m =>
    m.role === 'user' && !(m.content || '').startsWith('[resultado'))?.content || '';

  const stale = markSuperseded(old);
  const items = [];
  old.forEach((m, mi) => (m.content || '').split('\n').forEach((line, li) =>
    items.push({ mi, li, line, first: li === 0, stale: stale.has(mi) })));

  const score = buildBM25(items.map(it => it.line));
  const q = [...new Set(tokens(query))];
  const nMsg = Math.max(old.length - 1, 1);
  items.forEach((it, i) => { it.bm = score(i, q); it.rec = it.mi / nMsg; });
  return { done: false, recent, old, used, items, query, recTie, pressure, head };
}

// Selección bajo un único presupuesto global, con MMR, y emisión con marcas de
// omisión para que el modelo sepa que falta algo.
function selectAndEmit(ctx, budgetTokens) {
  const { recent, old, items } = ctx;
  const head = ctx.head || [];
  let used = ctx.used;
  const cap = Math.max(40, Math.floor((budgetTokens - used) * 0.5));
  const idOf = it => it.mi * 100000 + it.li;
  const cost = it => Math.min(estTok(it.line), cap) + 1;

  const pool = [...items].sort((a, b) => b.score - a.score);
  const keep = new Set();

  // MMR: al elegir, penalizar el parecido con lo ya elegido. Es lo único que
  // mide por encima de BM25 a secas (+8,9 puntos).
  const lambda = Math.max(0.15, Math.min(0.8, 2 * measureRedundancy(pool)));
  const nCand = Math.max(400, Math.min(8000, Math.round(budgetTokens / 6)));
  const cand = pool.slice(0, nCand);
  const tok = new Map(cand.map(it => [idOf(it), simTokens(it.line)]));
  const maxSim = new Map(cand.map(it => [idOf(it), 0]));
  const byId = new Map(cand.map(it => [idOf(it), it]));
  const remaining = new Set(cand.map(idOf));
  while (remaining.size && used < budgetTokens) {
    let best = null, bestVal = -Infinity;
    for (const id of remaining) {
      const v = byId.get(id).score - lambda * maxSim.get(id);
      if (v > bestVal) { bestVal = v; best = id; }
    }
    remaining.delete(best);
    const it = byId.get(best), c = cost(it);
    if (it.score < 10) continue;                 // el MMR diversifica DENTRO de lo relevante
    if (used + c > budgetTokens) continue;
    keep.add(best); used += c;
    const bs = tok.get(best);
    for (const id of remaining) maxSim.set(id, Math.max(maxSim.get(id), jaccard(tok.get(id), bs)));
  }
  // VENTANA ELÁSTICA: el presupuesto es un TECHO, no una cuota que agotar. Sin
  // esto, el 38 % del presupuesto a 3.000 y el 56 % a 16.000 se iba en líneas
  // sin una sola palabra en común con la pregunta. Y lo irrelevante no es
  // lastre neutro: recuperar bien BATE al contexto completo (F1 28,09 vs
  // 22,56), o sea que rellenar hasta el borde reintroduce a mano lo que la
  // compresión venía a quitar. La ventana se para cuando se acaba la evidencia
  // (estrato ≥ 10), no cuando se acaban los tokens.
  // ⚠️ Es un INTERCAMBIO: gratis con presupuesto apretado (el de los
  // productos), pero a 32.000 ahorra el 60 % de tokens a costa de 8,9 puntos de
  // presencia del dato. Que eso compense depende de si menos ruido mejora la
  // respuesta, y este banco mide presencia, no calidad.
  for (const it of pool) {
    const id = idOf(it); if (keep.has(id)) continue;
    if (it.score < 10) break;                    // se acabó lo relevante
    const c = cost(it);
    if (used + c > budgetTokens) continue;
    keep.add(id); used += c;
  }

  // ── CONTRATO DE PRESUPUESTO ────────────────────────────────────────────────
  // El coste por línea ignora la sobrecarga por mensaje y las marcas de omisión,
  // así que la suma de costes NO es lo que se emite. Sin esta corrección el
  // empaquetador se pasa ~1,6-1,8× de lo que se le pide — medido — y eso es
  // precisamente el «Too many tokens» que este fichero existe para evitar.
  // Se mide el tamaño REAL emitido y se devuelven las líneas peor puntuadas
  // hasta que la salida cabe de verdad.
  const emit = () => {
    let t = recent.reduce((s, m) => s + tokEstimate(m), 0) + head.reduce((s, m) => s + tokEstimate(m), 0);
    let open = 0;
    old.forEach((m, mi) => {
      let any = false, run = 0, sub = 0;
      (m.content || '').split('\n').forEach((line, li) => {
        if (keep.has(mi * 100000 + li)) {
          if (run) { sub += 8; run = 0; }
          sub += Math.min(estTok(line), cap); any = true;
        } else run++;
      });
      if (any) { if (run) sub += 8; t += sub + 4; open++; }
    });
    if (open < old.length) t += 12;
    return t;
  };
  let realized = emit();
  if (realized > budgetTokens) {
    const kept = items.filter(it => keep.has(idOf(it))).sort((a, b) => a.score - b.score);
    let p = 0;
    while (realized > budgetTokens && p < kept.length) {
      const over = realized - budgetTokens; let freed = 0;
      while (p < kept.length && freed < over) {
        const it = kept[p++];
        keep.delete(idOf(it));
        freed += Math.min(estTok(it.line), cap);
      }
      realized = emit();
    }
  }

  const packed = [];
  let droppedMsgs = 0;
  old.forEach((m, mi) => {
    const out = []; let skipped = 0;
    (m.content || '').split('\n').forEach((line, li) => {
      if (keep.has(mi * 100000 + li)) {
        if (skipped) { out.push(`  […${skipped} líneas omitidas…]`); skipped = 0; }
        out.push(estTok(line) > cap ? line.slice(0, cap * 3) + ' …' : line);
      } else skipped++;
    });
    if (skipped && out.length) out.push(`  […${skipped} líneas omitidas…]`);
    if (!out.length) { droppedMsgs++; return; }
    packed.push({ role: m.role, content: out.join('\n') });
  });
  if (droppedMsgs) packed.push({ role: 'user', content: `[…${droppedMsgs} mensajes antiguos omitidos…]` });
  return [...head, ...packed, ...recent];
}

/**
 * Empaqueta el historial en `budgetTokens` — vía léxica, síncrona.
 * Es la que se usa por defecto: no necesita modelo, ni red, ni nada.
 */
export function packHistory(history, budgetTokens = 2200) {
  if (!history.length) return history;
  const ctx = prepare(history, budgetTokens);
  if (ctx.done) return [...(ctx.head || []), ...ctx.recent];
  const max = ctx.items.reduce((m, it) => Math.max(m, it.bm), 0) || 1;
  for (const it of ctx.items) {
    // Dos estratos separados por 10 — más de lo que la penalización MMR (≤0.5)
    // puede recorrer, así que una línea sin relevancia NUNCA adelanta a una que
    // sí la tiene. Dentro de cada estrato: BM25 arriba, desempate abajo.
    it.score = (it.bm > 0 && !it.stale) ? 10 + it.bm / max : (ctx.recTie ? it.rec : 0);
    if (it.first) it.score = Math.max(it.score, 0.5);   // cabecera de procedencia
  }
  return selectAndEmit(ctx, budgetTokens);
}

/**
 * Igual, más una segunda opinión SEMÁNTICA fusionada por rangos.
 *
 * `embed(textos) -> vectores`. Se codifica por bloques de líneas, no línea a
 * línea, porque codificar cada línea es prohibitivo y la señal sobrevive al
 * troceado.
 *
 * ★ El tamaño de bloque es FIJO a propósito, y es lo que hace que la caché
 * sirva. Con bloques fijos las fronteras no se mueven al crecer el historial
 * (0-4, 5-9, …), así que el texto de un bloque ya codificado NO cambia nunca y
 * un turno sólo paga lo NUEVO. Si el tamaño se DERIVA del número de líneas,
 * cada vez que ese número cruza un umbral cambian TODOS los bloques y la caché
 * falla entera — medido, el turno pasa a encarecerse según avanza la sesión en
 * vez de abaratarse. Es el «indexar al escribir» del que depende todo esto. Si no se pasa `embed`, o si falla, cae limpiamente a la vía léxica.
 *
 * Por qué fusionar y no sustituir: medido, BM25 y los embeddings EMPATAN
 * en global, pero NO hacen el mismo trabajo. Partiendo las preguntas por solape
 * de vocabulario con la respuesta: sin solape, embeddings 24,28 > BM25 18,60;
 * con solape, BM25 29,33 > embeddings 23,58. La fusión por rangos se queda con
 * los DOS (24,05 / 32,73). Lo semántico no sustituye al léxico: le cubre el
 * punto ciego.
 */
// El lado semántico va tras bandera y APAGADO por defecto. La ganancia es real
// (+4,50 F1) pero el precio no es despreciable y depende del equipo de quien lo
// usa: son ~235 MB la primera vez, y sin WebGPU el turno se encarece siempre.
// Cableado, probado, y se enciende a petición. Con la bandera apagada embed.js
// —y con él transformers.js y el modelo— NI SE IMPORTA: coste exactamente cero.
//   localStorage.setItem('elffuss.semantic', 'on')
function semanticoOn() {
  try { return localStorage.getItem('elffuss.semantic') === 'on'; } catch { return false; }
}

export async function packHistoryAsync(history, budgetTokens = 2200, opts = {}) {
  let { embed, block = 5, cache } = opts;
  if (!history.length) return history;
  // Sin `embed` explícito, se resuelve por bandera con import DINÁMICO.
  if (!embed && semanticoOn()) {
    try {
      const m = await import('./embed.js');
      embed = m.embed; cache = cache || m.embedCache();
    } catch { /* sin modelo → vía léxica, la app NO deja de funcionar */ }
  }
  if (!embed) return packHistory(history, budgetTokens);
  const ctx = prepare(history, budgetTokens);
  if (ctx.done) return [...(ctx.head || []), ...ctx.recent];

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
      const rel = !it.stale && (it.bm > 0 || (it.sem || 0) > 0);
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
