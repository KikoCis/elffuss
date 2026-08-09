# Fact-recall benchmark

It measures a context packer by answering **one single question**, with no model anywhere in the loop:

> The agent read a definition halfway through the session. At the end it is asked for it.
> **Is that definition still inside the packed context?**

## Why there is no model judging

Because a benchmark whose result depends on which judge you pick **is no use for deciding between two packers**.

Scoring exactly the same answers, with the same questions, three different judges gave us:

| judge | result |
|---|---|
| an 11 GB reasoning model | **WRONG on everything** — it reasoned correctly, but wrote into another field |
| a 7B with the permissive prompt | **CORRECT on everything**, including *"nurse"* against the reference *"teacher"* |
| the same 7B with the hardened prompt | 8/8 on the control |

The first two were not bad models: one was reasoning correctly and the other was answering out of inertia. **The only difference between the second and the third was the prompt.** A number that moves like that cannot arbitrate an engineering decision.

This benchmark does not have that problem: it is a presence check, deterministic, and it gives the same result twice in a row.

## How the sessions are generated

**They are not synthetic.** A real project is opened and real tools are run over it — list the tree, read paginated files, search — and every result that enters the history is the genuine output of that tool, in its real format: its thousands of lines of noise, its paths, its line numbers.

That matters because the failure being hunted only shows up with real material. A tool result is mostly noise with two useful lines inside it; with uniform synthetic text, any packer looks good.

The only scripted part is **which tool the agent calls next** — the part a model would decide — drawn from a seeded generator so there are many different sessions and a mean across seeds can be reported instead of one lucky run.

## Usage

```bash
node run.mjs --root <path-to-a-repo>
```

Options: `--ext .js` · `--budget 3000` · `--seeds 8` · `--packer <file.js>`

`--packer` must export `packHistory(history, budgetTokens)`. By default it uses this repository's own core, so the numbers below reproduce with nothing to configure.

## The three conditions

All of them get **the same token budget**. The only thing that changes is the selection policy.

| | what it does |
|---|---|
| `full` | the entire history, uncompressed — the ceiling, and it does not respect the budget |
| `tail` | the last messages until the budget is full, throw away the rest |
| `packer` | the packer being measured |

**`tail` is the bar that has to be cleared, and it is the reason this benchmark exists.** Four generations of our packer were each measured against the previous one, all of them winning, and none of them against `tail`. When `tail` was finally put in, it turned out that one of those versions **scored below it**: compressing with it was worse than not compressing at all. If your packer does not beat *"keep the last bit and throw away the rest"*, nothing else you measure about it means anything.

## Result over this very repository

```
node run.mjs --root ../core --ext .js --seeds 8
```

| budget | `tail` | **`packer`** | `full` (ceiling) |
|---|---|---|---|
| 3,000 | 48.4% | **93.8%** · 1,596 tok | 100% · 29,732 tok |
| 8,000 | 70.3% | **95.3%** · 2,965 tok | 100% · 29,732 tok |

Note the token column: at a 8,000 budget the packer spends 2,965 — it stops when it runs out of *relevant material*, not when it runs out of room. The budget is a ceiling, not a quota.

8 sessions, 64 probes.

⚠️ **These figures are a reference point, not a constant, and it is worth knowing why.** The corpus is this repository's own `core/`, and the sessions embed the genuine output of `git status`, `git log` and `ls -la` on the working tree. That is the whole point — real tool output, with its real noise — but it also means the numbers move when the tree moves. They are deterministic for a fixed state (run it twice, get the same thing) and they shifted by a couple of points when the comments in `core/` were translated to English, because translating the corpus *is* changing the corpus.

So: reproduce the ordering, not the third decimal. If `packer` is not far above `tail` on your tree, that is the signal — not whether it lands on 93.8.

## What it does NOT measure

- **That the model uses well what it receives.** Presence is a necessary condition, not a sufficient one: having the evidence in front of you does not guarantee getting it right. For that you need a benchmark with a model answering, with all the arbitration problems described above.
- **Questions whose answer is in no single line.** *"How many files have you touched?"* is spread across forty messages and no top-k selection reaches it, by construction.
- **Conversation.** This is built on agent sessions with tools. A packer tuned here can lose in dialogue: it happened to us, and the cause turned out to be the word splitter, not the packing policy.

Apache-2.0, like the rest of the repository.
