// SEMANTIC side of the context engine (the companion to context.js).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY IT EXISTS
//
// `context.js` already ships the complete hybrid path (`packHistoryAsync`):
// BM25 and embeddings fused by rank. What it was missing was an `embed`
// function, so it fell back to the lexical path and in production only BM25 ran.
//
// Measured on LoCoMo (200 questions, the benchmark repo's own F1, a real model
// answering, same token budget):
//
//     FULL context, uncompressed .......... 22.56
//     BM25 (what ran until now) ........... 23.59
//     embeddings alone .................... 23.95
//     RANK fusion (this) .................. 28.09   ← +4.50 over BM25
//
// The reason it adds anything is not that the semantic side is "better": overall
// they TIE (23.59 vs 23.95). They do DIFFERENT jobs. Splitting the same
// questions by vocabulary overlap between question and answer:
//
//                            no overlap (n=107)   overlap (n=93)
//     BM25 ...................... 18.60               29.33
//     embeddings ................ 24.28               23.58
//     rank fusion ............... 24.05               32.73
//
// When the question does NOT literally name what it is looking for, BM25 sinks
// (18.60) and the semantic side holds up (24.28). When it does name it, BM25
// wins (29.33). The fusion keeps both. The semantic side does not replace the
// lexical one: it covers its blind spot. That — and not an overall gain — is
// what is being wired up here.
//
// ─────────────────────────────────────────────────────────────────────────────
// MODEL CHOSEN — Xenova/multilingual-e5-small, dtype q8 (118 MB)
//
// Hard requirements and how it meets them:
//   · transformers.js: it is the official ONNX conversion by the library's own
//     maintainer → it loads with the SAME `pipeline()` providers/onnx.js uses.
//   · small: 118 MB at q8. It is the lightest variant in the repo (q4 weighs
//     MORE — 398 MB — because the embedding matrix of a 250k vocabulary does not
//     quantise as well; here "fewer bits" does not mean less disk).
//   · multilingual: XLM-R tokeniser, 100 languages. The prompts are in Spanish
//     and the code is in English, and that crossing is exactly the lexical
//     blind spot.
//   · licence: MIT (intfloat/multilingual-e5-small upstream).
//   · a 512-token window, which is what the blocks the packer assembles need;
//     this is not a single-sentence model.
//
// Rejected, and why:
//   · Xenova/all-MiniLM-L6-v2 (23 MB, Apache-2.0) — 5× cheaper, but English
//     ONLY. Spanish is precisely the case we came here to cover.
//   · Xenova/paraphrase-multilingual-MiniLM-L12-v2 (118 MB, Apache-2.0) — same
//     weight, but it is tuned for SENTENCE paraphrase with a 128-token window:
//     it would cut the blocks in half.
//   · onnx-community/embeddinggemma-300m-ONNX (175 MB at q4f16 + external
//     weights) — better quality, but 1.5× the download and a Gemma licence
//     (commercial use permitted, but with a use policy and redistribution
//     obligations), not a clean commercial licence.
//   · ibm-granite/granite-embedding-107m-multilingual (Apache-2.0) — only
//     publishes ONNX in fp32: 428 MB, 3.6× the download.
//   · minishlab/potion-multilingual-128M (MIT) — static and extremely fast, but
//     its only ONNX weighs 512 MB and transformers.js does not support it
//     out of the box.
//
// DTYPE BY DEVICE — measured, not assumed. Same model, same batch of blocks,
// changing only dtype and device (relative cost, 1.0 = the best):
//
//     fp16 / WebGPU ....  1.0×   (235 MB)   ← the pick when there is an adapter
//     q4f16/ WebGPU ....  0.6×   (205 MB)   with medium blocks; see point 2
//     q8   / wasm ......  8.9×   (118 MB)   ← the safety net
//     fp32 / wasm ...... 11.0×   (470 MB)
//     q8   / WebGPU .... 14.1×   (118 MB)   ← WORSE than on CPU
//
// Two things that contradict intuition, which is why they are written down:
//   1. 8-bit integers are NOT accelerated on WebGPU: ORT-web has no kernels for
//      those operators and ends up bouncing back and forth to the CPU. The
//      smallest file turns out to be the SLOWEST on the GPU. Picking a dtype by
//      download size, without measuring, would have given the worst possible
//      combination.
//   2. With SHORT texts — which is our case, see the block sizing in context.js —
//      4-bit flips around and loses to fp16 (2.6× slower on single lines): at
//      those lengths you pay more to undo the quantisation than you save in
//      bandwidth. Hence fp16 and not q4f16, even though q4f16 wins on large
//      blocks.
//
// Hence the rule: fp16 if there is a real WebGPU adapter, and q8/wasm as the
// safety net. The safety net WORKS but it is ~9× slower, to the point of being
// noticeable on every turn, and that is one of the reasons the semantic side is
// off by default (see context.js).
// ─────────────────────────────────────────────────────────────────────────────

import { createEmbedCache } from './context.js';

export const EMBED_MODEL = {
  id: 'Xenova/multilingual-e5-small',
  dims: 384,
  label: 'multilingual-e5-small',
  // dtype → file → download
  webgpu: { dtype: 'fp16', sizeMB: 235 },
  wasm: { dtype: 'q8', sizeMB: 118 },
};

// The model's window is 512 tokens; trimming before tokenising avoids paying to
// split text the model itself is going to discard.
const MAX_CHARS = 2000;

// Small batches: transformers.js pads every batch up to its longest item, so a
// giant batch makes everyone pay the length of the worst element.
const BATCH = 16;

// e5 was ALWAYS trained with a prefix ('query: ' / 'passage: '), never with bare
// text. the packer calls the same `embed` for the question and for the blocks,
// and there is no way to tell them apart without touching the core; the model's
// authors document using 'query: ' on BOTH sides for symmetric use. Dropping it
// altogether would be worse: the model never saw that distribution.
const PREFIX = 'query: ';

let pipePromise = null;
export let backend = null;   // {device, dtype, sizeMB} once resolved

/**
 * LAZY loading: none of this is touched at startup. The whole module is
 * dynamically imported from context.js only when the flag is on, and the model
 * is not downloaded until the first request that genuinely uses it.
 */
function getPipe(onProgress) {
  if (!pipePromise) {
    pipePromise = (async () => {
      const tf = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4');
      // navigator.gpu can EXIST without a real adapter (same care as in
      // providers/onnx.js): check the adapter, not the object. Choosing wrong
      // here means downloading 235 MB only to end up running on the CPU.
      let device = 'wasm';
      if (navigator.gpu) {
        try { device = (await navigator.gpu.requestAdapter()) ? 'webgpu' : 'wasm'; }
        catch { device = 'wasm'; }
      }
      const cfg = { device, ...EMBED_MODEL[device] };
      const pipe = await tf.pipeline('feature-extraction', EMBED_MODEL.id, {
        device,
        dtype: cfg.dtype,
        progress_callback: onProgress,
      });
      backend = cfg;   // only once it is genuinely ready: isReady() does not lie
      return pipe;
    })().catch(e => {
      pipePromise = null;   // do not let a network failure leave the module dead
      backend = null;
      throw e;
    });
  }
  return pipePromise;
}

/** Optional preload (e.g. from Settings) without blocking any turn. */
export function warmup(onProgress) { return getPipe(onProgress); }

/** Already loaded? Useful to decide whether a turn will pay for the download. */
export function isReady() { return backend !== null; }

/**
 * embed(texts) → normalised 384-dimension vectors.
 * The exact contract `packHistoryAsync` expects: if this throws, the packer
 * takes the lexical path without breaking and without complaining.
 */
export async function embed(texts) {
  if (!texts || !texts.length) return [];
  const pipe = await getPipe();
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH)
      .map(t => PREFIX + String(t == null ? '' : t).slice(0, MAX_CHARS));
    const t = await pipe(batch, { pooling: 'mean', normalize: true });
    for (const v of t.tolist()) out.push(Float32Array.from(v));
  }
  return out;
}

// Session cache BY CONTENT. This is not an optimisation: it is what makes the
// idea viable at all. the packer reassembles the blocks from the start of the
// history on every turn, so without a cache a text already encoded on turn 3
// would be re-encoded on turn 4, on turn 5 and on turn 20 — the cost would grow
// with the SQUARE of the number of turns. With a cache, each block is encoded
// once per session and a turn only pays for the new blocks.
// The ceiling is deliberately generous: the packer chunks the ENTIRE history on
// every turn, so if the cache evicts entries the next turn asks for again, they
// get re-encoded for nothing. These are 384-float vectors: ~12 MB when full.
let cache = null;
export function embedCache() {
  // The signature is createEmbedCache(embed, max) with a NUMBER. Passing an
  // object here meant `store.size > max` compared a number against an object,
  // which is always false: the cache grew without bound and never evicted.
  if (!cache) cache = createEmbedCache(embed, 8000);
  return cache;
}

/** For diagnostics/settings: how many texts the session has cached so far. */
export function embedCacheSize() { return cache ? cache.size() : 0; }
