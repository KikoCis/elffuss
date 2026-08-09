# ✳ Elffuss — core

Elffuss is an agent runtime that lives **entirely in the browser**: no build step, no backend, no install — ES modules served exactly as they are written. This repository is the shared core behind two real products, and its centrepiece is the part that decides what an agent still remembers once the history stops fitting.

**Every number below is reproducible with one command**, against this repository's own source:

```bash
node bench/run.mjs --root core --ext .js --seeds 8
```

No API key, no model, no network, nothing to configure. That is the whole difference between this and a README full of figures nobody can check.

---

## The context manager

[`core/context.js`](core/context.js) selects the history by **relevance to the live question** rather than by recency:

- **BM25 with endogenous IDF.** The rarity of a term is computed from the conversation itself, so there is no hand-written stoplist and nothing to localise — it works in whatever language the session happens to be in, including a session that mixes two.
- **Line granularity.** A tool result is mostly noise with two useful lines inside it. Keeping it whole or dropping it whole wastes the budget in both directions.
- **Redundancy control (MMR)**, with the penalty derived from the material's *measured* redundancy instead of a constant.
- **A token budget that is actually honoured.** The emitted size is measured and lines are handed back until the output genuinely fits.
- **Staleness and absolute dates, resolved at write time.** A file read on turn 3 and edited on turn 20 has two versions in the history, and the stale one scores just as well. That is not inefficiency, it is incorrectness — and neither is "we deployed it yesterday", written on turn 3 and read on turn 40.

Optionally, a **semantic second opinion fused by rank** ([`core/embed.js`](core/embed.js)).

### Agent sessions — fact recall, no LLM judge

The agent read a definition halfway through a real session; at the end it is asked for it. The benchmark asks one question: is that definition still in the packed context? Every condition gets the same token budget.

| budget | `tail` | **`packer`** | `full` (ceiling) |
|---|---|---|---|
| 3,000 | 48.4% | **93.8%** · 1,596 tok | 100% · 29,732 tok |
| 8,000 | 70.3% | **95.3%** · 2,965 tok | 100% · 29,732 tok |

`tail` — keep the last messages until the budget is full, throw away the rest — is the bar that has to be cleared. It is there because four generations of this packer were each measured against the previous one, all of them winning, and none of them against `tail`. When `tail` was finally put in, one of those versions turned out to score *below* it.

### Long-term dialogue — F1, with a real model answering, at ~8% of the context

| | F1 |
|---|---|
| **the full context, uncompressed** | **22.56** |
| tail truncation | 6.62 |
| hand-written heuristics | 6.07 |
| BM25 without IDF | 20.34 |
| BM25 | 23.59 |
| embeddings | 23.95 |
| **rank fusion** | **28.09** |

**Retrieving well beats sending everything**: 28.09 against 22.56, using 8% of the tokens. What is irrelevant is not neutral ballast — it distracts. That result is also why the packer stops when the evidence runs out instead of when the tokens run out: filling right up to the edge puts back by hand exactly what the compression came to remove.

---

## What was measured, and not assumed

- **Turning the hand-written heuristics on cost −3.02 F1.** It was not that they added nothing — they subtracted.
- **Removing the IDF costs −3.25 F1.** Endogenous rarity does real work, and it replaces any hand-written stoplist, in any language.
- **The word splitter tuned for code cost 12.8 points on its own benchmark.** It required tokens to start with a letter, so `3pm`, `2nd` and `5` vanished whole, and it kept `src/utils.js` as a single token, so asking about `utils` matched nothing. Fixing only that, with everything else held equal, moved fact recall from 82.1% to 94.9%. It was never the packing policy.
- **Lexical and semantic tie overall but cover different gaps.** When the question does not literally name what it is looking for, embeddings win (24.28 vs 18.60); when it does, BM25 wins (29.33 vs 23.58). Fusing by rank takes essentially the better of the two columns — it matches the semantic side where the semantic side wins (24.05 vs 24.28, i.e. it gives up 0.23) and clears the lexical side where the lexical side wins (32.73 vs 29.33, +3.40). So it is not free in both directions, but the trade is heavily in its favour. The semantic side does not replace the lexical one — it covers its blind spot.

---

## What is honest about this

- **The dialogue benchmark is CC BY-NC.** It is something we measure against, not something shipped here. The benchmark in [`bench/`](bench/) is the one in this repository, and it runs on your own code.
- **The semantic side is off by default.** The gain is real (+4.50 F1), but it costs a sizeable model download the first time, and without WebGPU it makes every turn more expensive. It is wired up and tested, and it turns on by request. With the flag off, `embed.js` — and with it transformers.js and the model — is not even imported.
- **The engine is tuned for agent sessions.** In dialogue it went as far as losing to a bare BM25 until the word splitter was fixed. A packer tuned on one shape of history can lose on another, and this one was.

---

## What is in `core/`

Vanilla ES modules, no dependencies, no build:

| Module | What it does |
|---|---|
| `context.js` | The context manager described above: BM25 with endogenous IDF, line granularity, redundancy control, a guaranteed token budget, staleness and date resolution at write time, and optional rank fusion with a semantic ranker. |
| `embed.js` | The semantic side: a small multilingual embedding model in the browser, loaded lazily and only behind the flag, with a per-content session cache. |
| `ceo.js` | Autonomous "CEO brain": when the user is idle, several profiles think in parallel over the workspace and leave improvement proposals. It never modifies existing files, and it stops the moment the user comes back. |
| `mind.js` | The Mind view: the brain's thinking rendered as a 3D world, with the project's real city underneath and a beam dropping onto each file as it is touched. |
| `skills.js` | Claude Code skills: installs `SKILL.md` from `anthropics/skills`, the official plugins, or any public repo, and injects them into the system prompt. |
| `md.js` | Safe markdown renderer for the chat — all HTML escaped first, then a bounded set of transformations. |
| `humanize.js` | Turns a tool call into a human sentence, so the user is never shown raw JSON — including mid-stream, before the JSON has closed. |
| `splash-gl.js` | WebGL particle galaxy for the splash screen: GL_POINTS and additive blending, computed entirely in the vertex shader. |
| `telemetry.js` | Opt-in error/feedback mailbox, off by default. Code and project content are never sent. |
| `providers/api.js` | Generic provider for external APIs: OpenAI-compatible and Anthropic Messages, with SSE streaming, called directly from the user's browser so the key never passes through a server of ours. |

---

## Design rules

- **Everything in the browser.** Models run locally; external providers are opt-in and their keys never leave the user's browser.
- **No build.** ES modules served as they are. Clone and open.
- **Nothing is chosen by intuition.** Every knob in the context manager either comes out of a measurement or comes out of the measured compression pressure at run time.

## Using it

The products **vendor** the core into `web/js/` (same file names) and keep it in sync with their own `sync-core.sh`, so each repository stays self-contained and can be cloned and opened with nothing installed.

## The products

- **[Elffuss Claw](https://elffuss-claw.utopiaia.com)** — an agentic web OS: the chat is the interface, and apps are created as HTML on the fly.
- **[Elffuss Code](https://elffuss-code.utopiaia.com)** — a VS Code-style web IDE with the coding agent built in.

The full story, including what went wrong: **<https://bitacora.utopiaia.com/posts/16-beaten-by-doing-nothing.html>**

## Licence

Apache License 2.0 — see [LICENSE](LICENSE).

---

## References

Robertson, S. E., Walker, S., Jones, S., Hancock-Beaulieu, M. M., & Gatford, M. (1994). *Okapi at TREC-3.* TREC-3.

Robertson, S. E., & Zaragoza, H. (2009). *The Probabilistic Relevance Framework: BM25 and Beyond.* Foundations and Trends in Information Retrieval, 3(4). <https://doi.org/10.1561/1500000019>

Spärck Jones, K. (1972). *A Statistical Interpretation of Term Specificity and Its Application in Retrieval.* Journal of Documentation, 28(1).

Carbonell, J., & Goldstein, J. (1998). *The Use of MMR, Diversity-Based Reranking for Reordering Documents and Producing Summaries.* SIGIR 1998.

Cormack, G. V., Clarke, C. L. A., & Buettcher, S. (2009). *Reciprocal Rank Fusion Outperforms Condorcet and Individual Rank Learning Methods.* SIGIR 2009. <https://doi.org/10.1145/1571941.1572114>

Xiao, G., Tian, Y., Chen, B., Han, S., & Lewis, M. (2024). *Efficient Streaming Language Models with Attention Sinks.* ICLR 2024. <https://arxiv.org/abs/2309.17453>

Snodgrass, R., & Ahn, I. (1985). *A Taxonomy of Time in Databases.* SIGMOD 1985.
