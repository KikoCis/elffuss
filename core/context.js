// Context manager: selecting the history by RELEVANCE against the live
// question. BM25 with endogenous IDF + redundancy control (MMR), and optionally
// a second, semantic opinion fused by rank.
//
// ── what changed from the previous version, and why ─────────────────────────
//
// 1. OUT goes the hand-written stoplist. There used to be a STOP list of ~90
//    Spanish words. IDF is already computed over the history itself, so
//    whatever is ubiquitous gets near-zero weight by construction — with no
//    dictionary and without knowing what language we are in. A hand-written
//    list only knew Spanish: in an English coding session it filtered nothing,
//    and in any language it aged. Endogenous IDF adapts to every conversation.
//
// 2. OUT goes the blind trimming of old results. Old `[resultado …]` messages
//    used to be truncated to 600 characters BEFORE being scored. You cannot
//    retrieve what you threw away before measuring whether it mattered: if the
//    answer was at character 900, there was no longer any way to find it. Now
//    it is scored first and trimmed afterwards, and per line.
//
// 3. LINE granularity, not message granularity. A tool result is mostly noise
//    with two useful lines in it; keeping it whole or dropping it whole wastes
//    budget in both directions.
//
// 4. REDUNDANCY control (MMR). It is the only thing that adds anything on top
//    of BM25, and not much: +2.4 points at full scale. (A 3-seed smoke test
//    said +8.9; that was seed noise. BM25 with endogenous IDF does almost all
//    of the work.)
//
// 5. The knobs come from the measured PRESSURE, not from constants — see prepare().
//
// 6. ABSOLUTE DATES at write time. "yesterday", said on turn 3, is a lie on
//    turn 40, and that is NOT a retrieval failure: the line is retrieved just
//    fine and what it carries is false. The turn's date is annotated next to
//    the original — see annotateDates. Our own probe (the fact benchmark cannot
//    see this): the date goes from being present 0% of the time to 100% of the
//    time, for +7 tokens.
//
// 7. TALLY CARD, behind a flag. "how many files have you touched?" is in no
//    line at all; no top-k finds it, by construction. It is counted at write
//    time — see buildLedger. It costs −0.7 points of recall at budget 3,000 and
//    nothing at 16,000, so it is off by default.
//
// Measured at equal token budget (fact recall, no LLM judge; 25 sessions,
// 174 probes):
//     tail truncation .............  7.0%
//     previous packer ............. 15.1%
//     this one .................... 65.3% ± 8.5
//
// The budget is in tokens (~4 chars/token). The last RECENT messages are kept
// verbatim as long as they fit in their reserve; everything else competes.

const RECENT = 6;
// The recent-messages reserve is no longer a constant: it comes out of the
// measured pressure (see prepare). Without a cap, one huge result eats the
// entire budget.
const MAX_MSG_CHARS = 12000;
// λ and the number of candidates are NOT constants: see measureRedundancy() and
// selectAndEmit(). A fixed λ destroys good information when the material is not
// redundant, and a fixed 600 candidates leaves most of the history unlooked-at
// as soon as the budget is large — which is the real case.
const RRF_K = 60;

// No stoplist: IDF takes care of that. Two-character tokens are allowed
// because in code the short identifiers are sometimes exactly what is being
// looked for (`fs`, `db`, `id`).
// It emits the COMPOUND token and also its PARTS.
//
// The previous tokeniser was tuned for code and lost in dialogue: it required
// starting with a letter — so "3pm", "2nd" or "5" disappeared entirely, and in
// conversation those are times, ordinals and dates — and it kept
// `src/utils.js` as ONE token, so asking about "utils" did not match the line
// that contains it.
//
// Measured: changing ONLY this, with everything else equal, explained 3.5 of
// the 4.8 points that separated us from a BM25 with a different tokeniser on a
// dialogue benchmark. And on the agent-session benchmark it raised fact recall
// from 82.1% to 94.9% (budget 3,000) and from 85.9% to 100% (16,000). It was
// not the packing policy: it was the word splitter.
//
// The compound form is kept because in code it IS the identifier and it matches
// exactly; the parts are added for partial matching. You pay for more terms per
// line, and length normalisation already takes care of that.
const tokens = s => {
  const out = [], seen = new Set();
  const push = t => { if (t.length >= 2 && !seen.has(t)) { seen.add(t); out.push(t); } };
  for (const m of (s || '').toLowerCase().match(/[a-z0-9_áéíóúñü][\wáéíóúñü./-]*/g) || []) {
    push(m);
    if (/[./-]/.test(m)) for (const part of m.split(/[./-]+/)) push(part);
  }
  return out;
};
// Token estimator. `length/4` works for prose but badly UNDERESTIMATES code:
// dense punctuation (`{`, `=>`, `.`, `(`) are one-character tokens. Measured,
// counting by length alone made the packer believe things fitted and overshoot
// the budget by ~1.5× — that is, the "Too many tokens" this file exists to
// prevent. The LARGER of the two estimates is taken.
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

// BM25 with saturation (k1) and length normalisation (b). The IDF comes out of
// the very corpus it is handed — that is the whole point.
//
// Okapi BM25: Robertson, Walker, Jones, Hancock-Beaulieu & Gatford, "Okapi at
// TREC-3", TREC-3, 1994. Modern formulation and justification of k1/b:
// Robertson & Zaragoza, "The Probabilistic Relevance Framework: BM25 and
// Beyond", FnTIR 3(4), 2009 — https://doi.org/10.1561/1500000019
// The IDF comes from Sparck Jones, Journal of Documentation 28(1), 1972: the
// idea that what is rare is what informs, which is what all of this rests on.
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

// The material's REAL redundancy, sampled. A history of near-identical tool
// results calls for a hard penalty; a conversation where every line is
// different, almost none — and there a high λ only throws good information away.
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

// Reciprocal rank fusion (RRF — Cormack, Clarke & Buettcher, SIGIR 2009,
// https://doi.org/10.1145/1571941.1572114): POSITIONS are mixed, not scores, so
// there is no need to calibrate scales between an unbounded BM25 and a cosine
// in [-1,1].
function rrf(lists, k = RRF_K) {
  const out = new Map();
  for (const list of lists) list.forEach((id, r) => out.set(id, (out.get(id) || 0) + 1 / (k + r + 1)));
  return out;
}

/**
 * STALENESS — the same problem we already solved in the folder watcher, one
 * floor up.
 *
 * The agent reads a file on turn 3 and EDITS it on turn 20. BM25 retrieves both
 * versions and the old one scores just as high, because it shares all of its
 * vocabulary with the new one. The model sees stale content with no signal that
 * it is stale — and that is not inefficiency, it is INCORRECTNESS: no amount of
 * relevance fixes the fact that the datum is false. Measured with a
 * read→edit→re-read probe (8 seeds): the FALSE version survived 8/8; with this,
 * 0/8, and the true one still survives 8/8, at no cost in recall.
 *
 * The target does NOT come in the result: it comes from the preceding
 * assistant call. It is DEMOTED, not deleted — with one measured caveat: asking
 * EXPRESSLY for the previous value, the old one comes back 0 times out of 8. It
 * is in the set and it does not get retrieved, because it competes among
 * hundreds of zero-scoring lines and what comes back is decided by diversity,
 * not by the question. REACHABLE IS NOT RETRIEVABLE: the difference between "it
 * is no longer true" and "it never existed" is real in the structure and not
 * yet in the behaviour.
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

/**
 * ABSOLUTE DATES AT WRITE TIME — the other face of markSuperseded.
 *
 * "we deployed it yesterday", written on turn 3, is a LIE on turn 40. And no
 * BM25 knob fixes this, because it is not a retrieval failure: the line is
 * retrieved perfectly and the datum it carries is false. Same as staleness —
 * perfect relevance, incorrect content — except that here what goes stale is
 * the word, not the file.
 *
 * That is why it is resolved at WRITE time: while indexing, we still know when
 * it was said. One turn later, we no longer do.
 *
 *   · It is ANNOTATED next to the original, not substituted: "ayer
 *     (2026-08-07)". If the resolution gets it wrong, the model still sees the
 *     real sentence.
 *   · The reference is the TURN's stamp (`m.ts`/time/timestamp/date). With no
 *     stamp and no explicit `now`, NOTHING IS ANNOTATED: making up a date is
 *     precisely the failure this came to remove.
 *   · Honest precision: what the language states with day precision gets a day;
 *     what it states by week or month gets the range of that week or month.
 *   · ⚠️ Code fences and tool results are left alone: a `2026-08-07` inside a
 *     diff is not a temporal reference.
 *
 * Measured with our own probe (the fact benchmark cannot see this: it asks
 * about identifiers), 32 real sessions, the sentence in four different
 * positions: the line is retrieved 100% · the DATE is there unannotated 0% ·
 * annotated 100% · false date (had "now" been used) 0%. Cost: +7 tokens on
 * top of 2,223.
 */
const DAY = 86400000;
const isoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const isoMonth = d => isoDay(d).slice(0, 7);
const plusDays = (d, n) => { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; };
const plusMonths = (d, n) => { const x = new Date(d.getTime()); x.setDate(1); x.setMonth(x.getMonth() + n); return x; };
const weekOf = d => { const mon = plusDays(d, -((d.getDay() + 6) % 7)); return `${isoDay(mon)}…${isoDay(plusDays(mon, 6))}`; };
const DOW = { domingo: 0, lunes: 1, martes: 2, miércoles: 3, miercoles: 3, jueves: 4, viernes: 5, sábado: 6, sabado: 6,
              sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const WORD_N = { un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
                 a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const asNum = s => (/^\d+$/.test(s) ? parseInt(s, 10) : (WORD_N[s.toLowerCase()] || null));
// Honest precision: day → day, week → range of the week, month → month.
function shiftBy(ref, n, unit, sign) {
  if (n == null || n > 500) return null;
  const u = unit.toLowerCase()[0];
  if (u === 'd') return isoDay(plusDays(ref, sign * n));
  if (u === 's' || u === 'w') return weekOf(plusDays(ref, sign * 7 * n));
  if (u === 'm') return isoMonth(plusMonths(ref, sign * n));
  if (u === 'a' || u === 'y') return String(plusMonths(ref, sign * 12 * n).getFullYear());
  return null;
}
// dir<0 the strictly previous one · dir>0 the next one · dir=0 the most recent
// one, counting today. A bare weekday ("el lunes") is AMBIGUOUS in both
// languages: it resolves as backward-looking because in a work log it almost
// always is. It is the only rule here that can be wrong, and that is why the
// original stays.
function nearestDow(ref, target, dir) {
  const cur = ref.getDay();
  if (dir > 0) { const f = (target - cur + 7) % 7; return plusDays(ref, f || 7); }
  const b = (cur - target + 7) % 7;
  return plusDays(ref, -(dir < 0 ? (b || 7) : b));
}
const NUM_P = '\\d{1,3}|un[ao]?|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|an?|one|two|three|four|five|six|seven|eight|nine|ten';
const UNIT_P = 'd[ií]as?|semanas?|mes(?:es)?|años?|anos?|days?|weeks?|months?|years?';
const DOW_ES = 'lunes|martes|mi[ée]rcoles|jueves|viernes|s[áa]bado|domingo';
const DOW_EN = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday';
// Order = precedence: the alternation keeps the FIRST one that fits.
const WHEN = [
  // "por la mañana" (in the morning) is not "mañana" (tomorrow): it is matched
  // so that it is NOT annotated, and so the short rule never gets to see it.
  ['\\b(?:por|de|a|en|desde|hasta)\\s+la\\s+mañana\\b|\\b(?:esta|una|cada|toda\\s+la|la)\\s+mañana\\b', () => null],
  ['\\bantes\\s+de\\s+ayer\\b|\\banteayer\\b|\\bthe\\s+day\\s+before\\s+yesterday\\b', (m, r) => isoDay(plusDays(r, -2))],
  ['\\bpasado\\s+mañana\\b|\\bthe\\s+day\\s+after\\s+tomorrow\\b', (m, r) => isoDay(plusDays(r, 2))],
  [`\\bhace\\s+(${NUM_P})\\s+(${UNIT_P})\\b`, (m, r) => shiftBy(r, asNum(m[1]), m[2], -1)],
  [`\\b(${NUM_P})\\s+(${UNIT_P})\\s+ago\\b`, (m, r) => shiftBy(r, asNum(m[1]), m[2], -1)],
  [`\\bdentro\\s+de\\s+(${NUM_P})\\s+(${UNIT_P})\\b`, (m, r) => shiftBy(r, asNum(m[1]), m[2], 1)],
  [`\\bin\\s+(${NUM_P})\\s+(${UNIT_P})\\b`, (m, r) => shiftBy(r, asNum(m[1]), m[2], 1)],
  ['\\b(?:la\\s+)?semana\\s+(pasada|anterior|que\\s+viene|pr[óo]xima)\\b',
    (m, r) => weekOf(plusDays(r, /pasada|anterior/i.test(m[1]) ? -7 : 7))],
  ['\\b(last|next)\\s+week\\b', (m, r) => weekOf(plusDays(r, /last/i.test(m[1]) ? -7 : 7))],
  ['\\b(?:el\\s+)?mes\\s+(pasado|anterior|que\\s+viene|pr[óo]ximo)\\b',
    (m, r) => isoMonth(plusMonths(r, /pasado|anterior/i.test(m[1]) ? -1 : 1))],
  ['\\b(last|next)\\s+month\\b', (m, r) => isoMonth(plusMonths(r, /last/i.test(m[1]) ? -1 : 1))],
  [`\\bel\\s+(${DOW_ES})\\s+(pasado|que\\s+viene|pr[óo]ximo)\\b`,
    (m, r) => isoDay(nearestDow(r, DOW[m[1].toLowerCase()], /pasado/i.test(m[2]) ? -1 : 1))],
  [`\\b(last|next|this)\\s+(${DOW_EN})\\b`,
    (m, r) => isoDay(nearestDow(r, DOW[m[2].toLowerCase()], /last/i.test(m[1]) ? -1 : (/next/i.test(m[1]) ? 1 : 0)))],
  // With no modifier, an article or preposition is required: a bare "Monday"
  // may be a proper name or a file.
  [`\\bel\\s+(${DOW_ES})\\b`, (m, r) => isoDay(nearestDow(r, DOW[m[1].toLowerCase()], 0))],
  [`\\bon\\s+(${DOW_EN})\\b`, (m, r) => isoDay(nearestDow(r, DOW[m[1].toLowerCase()], 0))],
  ['\\banoche\\b|\\blast\\s+night\\b', (m, r) => isoDay(plusDays(r, -1))],
  ['\\bayer\\b|\\byesterday\\b', (m, r) => isoDay(plusDays(r, -1))],
  ['\\bhoy\\b|\\btoday\\b', (m, r) => isoDay(r)],
  ['\\bmañana\\b|\\btomorrow\\b', (m, r) => isoDay(plusDays(r, 1))],
];
const WHEN_RE = new RegExp(WHEN.map(w => `(?:${w[0]})`).join('|'), 'gi');
const WHEN_ONE = WHEN.map(w => new RegExp(`^(?:${w[0]})$`, 'i'));
// Fences, backticks, and an unclosed fence (a message still arriving).
const FENCE = /```[\s\S]*?```|```[\s\S]*$|~~~[\s\S]*?~~~|`[^`\n]+`/g;

export function annotateDates(text, refMs) {
  if (!text) return text;
  WHEN_RE.lastIndex = 0;
  if (!WHEN_RE.test(text)) return text;       // single sweep: the normal case leaves here
  const ref = new Date(refMs);
  if (isNaN(ref.getTime())) return text;
  const parts = []; let last = 0, f;
  FENCE.lastIndex = 0;
  while ((f = FENCE.exec(text))) {
    parts.push([text.slice(last, f.index), false], [f[0], true]);
    last = f.index + f[0].length;
  }
  parts.push([text.slice(last), false]);
  return parts.map(([s, isCode]) => isCode ? s : s.replace(WHEN_RE, (hit, ...rest) => {
    const whole = rest[rest.length - 1], at = rest[rest.length - 2];
    if (/^\s*\(\d{4}-\d{2}/.test(whole.slice(at + hit.length))) return hit;      // idempotent
    // `today()`, `memory::today`, `hoy_str` or `ayer.js` are CODE even when they
    // arrive without a fence: an unfenced tool call carries paths, and
    // annotating inside a path breaks it. A sentence-final full stop ("lo
    // hicimos ayer.") does get annotated.
    if (/[.:_/\\]$/.test(whole.slice(0, at)) || /^[(_]|^\.\w/.test(whole.slice(at + hit.length))) return hit;
    for (let i = 0; i < WHEN.length; i++) {
      const g = WHEN_ONE[i].exec(hit);
      if (!g) continue;
      const v = WHEN[i][1](g, ref);
      return v ? `${hit} (${v})` : hit;
    }
    return hit;
  })).join('');
}

const asTime = v => {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? (v < 1e11 ? v * 1000 : v) : null;
  if (typeof v.getTime === 'function') return Number.isFinite(v.getTime()) ? v.getTime() : null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

// History with the temporal references resolved. Returns the SAME array if
// there was nothing to annotate, so the normal case pays for no copies.
function datedHistory(history, now) {
  let touched = false;
  const out = history.map(m => {
    const c = m.content || '';
    if (!c || c.startsWith('[resultado')) return m;          // tool output: untouchable
    const ref = asTime(m.ts ?? m.time ?? m.timestamp ?? m.date ?? m.createdAt) ?? asTime(now);
    if (ref == null) return m;                                // no known date → nothing is invented
    const a = annotateDates(c, ref);
    if (a === c) return m;
    touched = true;
    return { ...m, content: a };
  });
  return touched ? out : history;
}

/**
 * AGGREGATION — what is in no line at all.
 *
 * "How many files have you touched?" is not spread across forty lines: it is
 * that the line to look for DOES NOT EXIST. No top-k finds it, and not because
 * it scores badly, but by construction. Like the dates, it is resolved at WRITE
 * time: counting as the results go past. A counter and nothing else — no model,
 * no generated summary, no judgement: it is a tally, and it reads the way
 * `wc -l` reads.
 *
 * The target of each call comes from the ASSISTANT's call (the result does not
 * carry it), same as in markSuperseded, and the family is decided by the VERB
 * in the tool's name: the products that share this design have different tools
 * (`code.read` / `fs.read`) and a closed list of names would go stale with the
 * first new product.
 */
const V_EDIT = /^(?:write|edit|create|save|patch|append|delete|remove|rm|move|rename|copy)$/;
const V_READ = /^(?:read|view|open|cat|show)$/;
const V_RUN = /^(?:run|exec|shell|bash|cmd)$/;
const CALL = /"tool"\s*:\s*"([^"]+)"[\s\S]{0,300}?"(?:path|file|filename|command|cmd)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
const ERR = /^\s*(?:ERROR\b|Error:|error:|Traceback \(most recent call last\))/;

export function buildLedger(msgs) {
  const read = new Map(), edited = new Map(), ran = new Map(), errs = new Map();
  let errN = 0;
  msgs.forEach((msg, i) => {
    const c = msg.content || '';
    if (c.startsWith('[resultado')) {
      for (const line of c.split('\n')) {
        if (!ERR.test(line)) continue;
        errN++; errs.set(line.trim().slice(0, 90), i);
        break;                       // we count failed RESULTS, not traceback lines
      }
      return;
    }
    if (msg.role !== 'assistant') return;
    CALL.lastIndex = 0;
    let m;
    while ((m = CALL.exec(c))) {
      const verb = m[1].split('.').pop().toLowerCase();
      if (!m[2]) continue;
      if (V_EDIT.test(verb)) edited.set(m[2], i);
      else if (V_READ.test(verb)) read.set(m[2], i);
      else if (V_RUN.test(verb)) ran.set(m[2], i);
    }
  });
  // An edited file is not counted as read as well: "how many have you touched"
  // cannot count the same file twice.
  for (const k of edited.keys()) read.delete(k);
  return { read, edited, ran, errs, errN };
}

/**
 * The card, bounded. Three rules, and all three come from measuring:
 *
 *  1. The TALLY always goes in and is the true total; the enumeration is what
 *     gets trimmed. A truncated tally that LOOKS complete ("8 files" when there
 *     were 200) is worse than giving none at all, so the number goes separately
 *     and the list says "+N más". When not even one entry fits, the row is left
 *     as just the number.
 *  2. The ceiling comes from the BUDGET, not from a constant.
 *  3. Room is taken from the row that spends the most TOKENS, not from the one
 *     with the most entries: two long error paths cost more than eight short
 *     names. Measured (32 sessions, budget 3,000, coverage of the files
 *     actually edited, at equal cost of ~148 tokens): trimming by number of
 *     entries 67.7% · trimming by cost 90.6%. With no card, 58.9%.
 *     And with the ceiling at 3% it drops to 57.3%: a card squeezed too tight
 *     gives the tally for free but its enumeration GETS IN THE WAY.
 *
 * ⚠️ The card is NOT free: on the usual fact benchmark (32 real sessions) it
 * costs −0.7 points at budget 3,000 (65.7% → 65.0%) and ±0.0 at 16,000. That is
 * why it sits behind a flag and off: whoever asks "how many files" wants it;
 * whoever does not is paying for nothing.
 */
function summaryCard(L, maxTok) {
  const rows = [['ficheros leídos', L.read], ['ficheros editados', L.edited],
                ['comandos', L.ran], ['errores', L.errs]];
  const totals = [L.read.size, L.edited.size, L.ran.size, L.errN];
  if (!totals.some(Boolean)) return null;
  // MOST RECENT first: if trimming is needed, whatever was just touched is what
  // they are most likely to ask about.
  const listed = rows.map(([, m]) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]));
  const caps = rows.map(() => 8);
  const line = i => {
    const items = listed[i].slice(0, caps[i]).map(s => s.length > 60 ? s.slice(0, 57) + '…' : s);
    const rest = totals[i] - items.length;
    return `${rows[i][0]} (${totals[i]})${items.length ? ': ' + items.join(' · ') : ''}` +
           `${rest > 0 && items.length ? ` · +${rest} más` : ''}`;
  };
  const compose = () => ['[recuento de la sesión · automático]']
    .concat(rows.map((r, i) => totals[i] ? line(i) : null).filter(Boolean)).join('\n');
  let text = compose();
  while (estTok(text) > maxTok) {
    let worst = -1, cost = 0;
    rows.forEach((r, i) => {
      if (!totals[i] || !caps[i]) return;
      const c = estTok(line(i));
      if (c > cost) { cost = c; worst = i; }
    });
    if (worst < 0) break;
    caps[worst] = Math.min(caps[worst], totals[worst]) - 1;
    text = compose();
  }
  return { role: 'user', content: text };
}

// Prepares the shared state: recent reserve, live question, lines and BM25.
function prepare(history, budgetTokens, opts = {}) {
  // Whatever is resolved at WRITE time goes before anything else, because it
  // changes the material that is about to be scored and what is going to fit:
  // the dates are annotated over the history, and the card is charged against
  // the budget BEFORE it is shared out — which is what makes it unconditional
  // without breaking the token contract.
  if (opts.dates !== false) history = datedHistory(history, opts.now);
  const card = opts.summary ? summaryCard(buildLedger(history),
    Math.max(24, Math.floor(budgetTokens * (opts.summaryFrac || 0.05)))) : null;
  const cardTok = card ? estTok(card.content) + 4 : 0;
  budgetTokens = Math.max(1, budgetTokens - cardTok);

  // Compression PRESSURE: what fraction of the history fits. Every knob that
  // depends on the regime comes from here, not from constants — 200k of history
  // against a 32k budget is not ruled by the same thing as 5k against 3k.
  const historyTok = history.reduce((s, m) => s + tokEstimate(m), 0);
  const pressure = Math.max(0, Math.min(1, budgetTokens / (historyTok || 1)));
  // With room to spare, keeping the last turns is cheap; under strain you have
  // to leave room for the SEARCH, which is what brings back the line from 30
  // turns ago.
  const recentFrac = 0.35 + 0.45 * pressure;
  // Recency only breaks ties UNDER PRESSURE. Measured in a sweep: under strain
  // (16× as much context as budget) it adds +11 points, because almost no line
  // has any relevance and what is new is the only bet left. With room to spare
  // it SUBTRACTS −8: there document order wins, because it keeps the stretches
  // together, and one contiguous fragment is worth more than scattered new lines.
  const recTie = pressure < 0.25;
  // The head goes in ALWAYS, with no gate: with the elastic window it stopped
  // being true that "with room to spare the brief survives on its own" — it
  // survived because we were filling right up to the edge. Measured, once we
  // stopped filling it fell from 100% to 0% at budget 16,000. It was an
  // accident of the padding, not of having room.

  // ── TAIL RESERVE — it is a FLOOR, not just a ceiling ───────────────────────
  // Stopping at the first message that does not fit turns the reserve into a cap
  // rather than a guarantee: measured, at budget 3,000 the tail was getting
  // 3-5% instead of the ~38% reserved, because ONE big tool result in the
  // second-to-last position blocked everything before it. The last turns are
  // what the model absolutely needs in order to know where it is, and that
  // cannot depend on the preceding turn having been bulky.
  // Until the floor (10%) is reached, a message that does not fit is TRUNCATED
  // through the middle instead of discarded. Above it, the usual behaviour.
  const reserve = Math.floor(budgetTokens * recentFrac);
  const floorTok = Math.floor(budgetTokens * 0.05);
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
  if (!old.length || used >= budgetTokens) return { done: true, recent, used, head: [], card, budget: budgetTokens };

  // ── HEAD RESERVE ───────────────────────────────────────────────────────────
  // The FIRST messages are kept verbatim and UNSCORED, just like the last ones,
  // and only under pressure (same gate as recency, same reason).
  //
  // The opening carries the BRIEF: what has to be done, under what constraints.
  // The rest of the session takes it as given, so nobody repeats it — and with
  // no repetitions there is no lexical overlap with the current question, which
  // means BM25 cannot rescue it no matter how much it matters. It is the only
  // content the agent CANNOT reconstruct by looking at the code.
  //
  // External backing: it is the central result of StreamingLLM (Xiao, Tian,
  // Chen, Han & Lewis, ICLR 2024, https://arxiv.org/abs/2309.17453) — the first
  // tokens act as attention SINKS and absorb 45-55% of the mass. A pure
  // retriever cannot see that: it is not a property of the text, but of how the
  // model uses it.
  //
  // Measured (A/B on the same code, 8 seeds, a probe asking about the brief
  // halfway through the session):
  //     budget  3,000:  the brief survives   0% →  100%
  //     budget 16,000:  the brief survives 100% →  100%
  //     mid-session facts: 85.7% → 85.7%  ·  91.1% → 91.1%
  // That is: it rescues the brief from never to always and costs NOTHING.
  // Head reserve DISABLED: it helped in agent sessions (the original brief went
  // from 0/5 to 5/5) but in dialogue there is no brief to protect and the
  // reserve charges without giving anything back — on LoCoMo it drops evidence
  // recall from 62.5% to 56.2% at the same token count. Set 0.05 to re-enable.
  const headReserve = 0;
  const head = []; let headUsed = 0;
  for (let i = 0; i < old.length; i++) {
    const m = clampMsg(old[i]), t = tokEstimate(m);
    if (headUsed + t > headReserve) break;
    head.push(m); headUsed += t;
  }
  old = old.slice(head.length);
  used += headUsed;
  if (!old.length || used >= budgetTokens) return { done: true, recent, used, head, card, budget: budgetTokens };

  // The LIVE question: the last user turn that is not a tool result. This is
  // what everything is scored against, not the initial task — what is relevant
  // changes on every turn.
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
  return { done: false, recent, old, used, items, query, recTie, pressure, head, card, budget: budgetTokens };
}

// Selection under a single global budget, with MMR, and emission with omission
// markers so that the model knows something is missing.
function selectAndEmit(ctx, budgetTokens) {
  const { recent, old, items } = ctx;
  const head = ctx.head || [];
  let used = ctx.used;
  const cap = Math.max(40, Math.floor((budgetTokens - used) * 0.5));
  const idOf = it => it.mi * 100000 + it.li;
  const cost = it => Math.min(estTok(it.line), cap) + 1;

  const pool = [...items].sort((a, b) => b.score - a.score);
  const keep = new Set();

  // MMR: when choosing, penalise similarity to what has already been chosen. It
  // is the only thing that measures above plain BM25 — and not by much:
  // +2.4 points at full scale. A 3-seed smoke test said +8.9 and that was
  // seed noise; the header carries the honest figure.
  // MMR is off: measured at zero contribution on both benchmarks (94.9% with
  // and without at a 3,000 budget, 100.0% and 100.0% at 16,000). It earned its
  // +2.4 before the elastic window and the splitter fix; those removed its job.
  const MMR_ON = false;
  const lambda = Math.max(0.15, Math.min(0.8, 2 * measureRedundancy(pool)));
  const nCand = Math.max(400, Math.min(8000, Math.round(budgetTokens / 6)));
  const cand = pool.slice(0, nCand);
  const tok = new Map(cand.map(it => [idOf(it), simTokens(it.line)]));
  const maxSim = new Map(cand.map(it => [idOf(it), 0]));
  const byId = new Map(cand.map(it => [idOf(it), it]));
  const remaining = new Set(MMR_ON ? cand.map(idOf) : []);
  while (remaining.size && used < budgetTokens) {
    let best = null, bestVal = -Infinity;
    for (const id of remaining) {
      const v = byId.get(id).score - lambda * maxSim.get(id);
      if (v > bestVal) { bestVal = v; best = id; }
    }
    remaining.delete(best);
    const it = byId.get(best), c = cost(it);
    if (it.score < 10) continue;                 // MMR diversifies WITHIN what is relevant
    if (used + c > budgetTokens) continue;
    keep.add(best); used += c;
    const bs = tok.get(best);
    for (const id of remaining) maxSim.set(id, Math.max(maxSim.get(id), jaccard(tok.get(id), bs)));
  }
  // ELASTIC WINDOW: the budget is a CEILING, not a quota to be used up. Without
  // this, 38% of the budget at 3,000 and 56% at 16,000 went on lines without a
  // single word in common with the question. And what is irrelevant is not
  // neutral ballast: retrieving well BEATS the full context (F1 28.09 vs
  // 22.56), which means filling right up to the edge puts back by hand exactly
  // what the compression came to remove. The window stops when the evidence
  // runs out (stratum ≥ 10), not when the tokens run out.
  // ⚠️ It is a TRADE-OFF: free with a tight budget (the products' case), but at
  // 32,000 it saves 60% of the tokens at the cost of 8.9 points of the datum
  // being present. Whether that pays off depends on whether less noise improves
  // the answer, and this benchmark measures presence, not quality.
  for (const it of pool) {
    const id = idOf(it); if (keep.has(id)) continue;
    if (it.score < 10) break;                    // the relevant material has run out
    const c = cost(it);
    if (used + c > budgetTokens) continue;
    keep.add(id); used += c;
  }

  // ── BUDGET CONTRACT ────────────────────────────────────────────────────────
  // The per-line cost ignores the per-message overhead and the omission
  // markers, so the sum of the costs is NOT what gets emitted. Without this
  // correction the packer overshoots what it was asked for by ~1.6-1.8× —
  // measured — and that is precisely the "Too many tokens" this file exists to
  // prevent. The REAL emitted size is measured and the worst-scoring lines are
  // handed back until the output genuinely fits.
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
  // The card is PROTECTED, like the head and the tail, and for the very same
  // reason: it does not compete on relevance because it cannot win — it is a
  // tally, it shares vocabulary with nothing, and BM25 would drop it every
  // time, which is exactly the failure it came to cover. It sits right next to
  // the last turns, with the live question, not at the beginning.
  return [...head, ...packed, ...(ctx.card ? [ctx.card] : []), ...recent];
}

/**
 * Packs the history into `budgetTokens` — lexical path, synchronous.
 * This is the one used by default: it needs no model, no network, nothing.
 */
export function packHistory(history, budgetTokens = 2200, opts = {}) {
  if (!history.length) return history;
  const ctx = prepare(history, budgetTokens, { summary: resumenOn(), ...opts });
  if (ctx.done) return [...(ctx.head || []), ...(ctx.card ? [ctx.card] : []), ...ctx.recent];
  const max = ctx.items.reduce((m, it) => Math.max(m, it.bm), 0) || 1;
  for (const it of ctx.items) {
    // Two strata separated by 10 — more than the MMR penalty (≤0.5) can span,
    // so a line with no relevance NEVER overtakes one that has some. Within
    // each stratum: BM25 on top, tie-break underneath.
    it.score = (it.bm > 0 && !it.stale) ? 10 + it.bm / max : (ctx.recTie ? it.rec : 0);
    if (it.first) it.score = Math.max(it.score, 0.5);   // provenance header
  }
  return selectAndEmit(ctx, ctx.budget);
}

/**
 * The same, plus a second SEMANTIC opinion fused by rank.
 *
 * `embed(texts) -> vectors`. Encoding happens per block of lines, not line by
 * line, because encoding every line is prohibitive and the signal survives the
 * chunking.
 *
 * ★ The block size is FIXED on purpose, and that is what makes the cache worth
 * anything. With fixed blocks the boundaries do not move as the history grows
 * (0-4, 5-9, …), so the text of an already-encoded block NEVER changes and a
 * turn only pays for what is NEW. If the size is DERIVED from the number of
 * lines, then every time that number crosses a threshold ALL the blocks change
 * and the cache misses entirely — measured, the turn starts getting more
 * expensive as the session advances instead of cheaper. It is the "index at
 * write time" that all of this depends on. If no `embed` is passed, or if it
 * fails, it falls back cleanly to the lexical path.
 *
 * Why fuse instead of replace: measured, BM25 and the embeddings TIE overall,
 * but they do NOT do the same job. Splitting the questions by vocabulary
 * overlap with the answer: with no overlap, embeddings 24.28 > BM25 18.60; with
 * overlap, BM25 29.33 > embeddings 23.58. Rank fusion keeps BOTH (24.05 /
 * 32.73). The semantic side does not replace the lexical one: it covers its
 * blind spot.
 */
// The semantic side sits behind a flag and is OFF by default. The gain is real
// (+4.50 F1) but the price is not negligible and it depends on whoever is
// running it: ~235 MB the first time, and without WebGPU every turn gets more
// expensive, always. Wired up, tested, and switched on on request. With the
// flag off, embed.js — and with it transformers.js and the model — IS NOT EVEN
// IMPORTED: exactly zero cost.
//   localStorage.setItem('elffuss.semantic', 'on')
function semanticoOn() {
  try { return localStorage.getItem('elffuss.semantic') === 'on'; } catch { return false; }
}

// The TALLY CARD is also behind a flag, and for the same reason: it costs ~150
// tokens of the budget and −0.7 points of recall at budget 3,000 (nothing at
// 16,000). In exchange the tally goes from 0% to 100% and the enumeration of
// what was edited from 58.9% to 90.6%. It pays off in the session that ends
// with "give me the list of what you touched"; in the rest you pay for nothing.
//   localStorage.setItem('elffuss.resumen', 'on')
function resumenOn() {
  try { return localStorage.getItem('elffuss.resumen') === 'on'; } catch { return false; }
}

export async function packHistoryAsync(history, budgetTokens = 2200, opts = {}) {
  let { embed, block = 5, cache } = opts;
  if (!history.length) return history;
  // With no explicit `embed`, it is resolved by flag with a DYNAMIC import.
  if (!embed && semanticoOn()) {
    try {
      const m = await import('./embed.js');
      embed = m.embed; cache = cache || m.embedCache();
    } catch { /* no model → lexical path, the app does NOT stop working */ }
  }
  if (!embed) return packHistory(history, budgetTokens, opts);
  const ctx = prepare(history, budgetTokens, { summary: resumenOn(), ...opts });
  if (ctx.done) return [...(ctx.head || []), ...(ctx.card ? [ctx.card] : []), ...ctx.recent];

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
    return selectAndEmit(ctx, ctx.budget);
  } catch {
    return packHistory(history, budgetTokens, opts);   // no model, no network, no quota → lexical
  }
}

/**
 * Embedding cache keyed by content — "think at write time": a text is encoded
 * ONCE per session even if it reappears twenty turns later.
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
