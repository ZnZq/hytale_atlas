# Hytale Asset Index — Design Documentation Set

This directory contains the design specification for a proposed tool that indexes
Hytale asset packs and the vanilla asset corpus into a queryable graph, exposed to
AI agents over MCP.

**Status: pre-implementation.** No code exists yet. These documents are the input
to the design and build process, not a description of a finished system.

## Reading order

| File | Purpose |
|---|---|
| `01-VISION.md` | What the tool is for, who uses it, what it must never become |
| `02-DOMAIN.md` | Hytale-specific facts, with confidence levels. **Read before any design work.** |
| `03-ARCHITECTURE.md` | Layers, graph model, indexing algorithm, storage, incremental updates |
| `04-MCP-SURFACE.md` | Tool surface exposed to agents, response discipline |
| `05-CODEC-EXTRACTION.md` | Deriving authoritative schema from the server JAR — highest risk, highest value |
| `06-CLI-UX.md` | `npx` entry point, autodetection, cache layout, degradation tiers |
| `07-PRIOR-ART.md` | Comparable systems worth studying before writing code |
| `08-ROADMAP.md` | Phasing, with explicit "stop and demo" points |
| `09-EVALUATION.md` | How to tell whether the tool actually helps |
| `OPEN-QUESTIONS.md` | **Everything that must be empirically verified.** Blockers go here. |

## Confidence markers

Every factual claim about Hytale in these documents carries one of:

- `[VERIFIED]` — sourced from official docs or confirmed community documentation; URL given
- `[REPORTED]` — stated by a secondary source (blog, wiki, tool README); plausible but unconfirmed
- `[ASSUMED]` — inferred by analogy or reasoning; **not** established fact
- `[UNKNOWN]` — explicitly open; see `OPEN-QUESTIONS.md`

**Do not treat `[ASSUMED]` or `[REPORTED]` items as settled.** Several core design
decisions hinge on facts that have not been checked against an actual Hytale
installation. Verifying them is cheap and should happen before the code that
depends on them is written.

These documents were compiled from web research in July 2026. Hytale is in Early
Access and its pack format, API, and file layout are explicitly subject to change
between versions. Re-verify anything load-bearing.

## Revision note

These documents were revised after a critical review pass. The substantive changes:

- **Localization is now a first-class part of the graph** (`03-ARCHITECTURE.md`
  §Localization). The original design indexed only identifiers, which would have
  broken natural-language search — the tool's primary entry point. This was the
  most serious defect found.
- **Q10 (legal) and Q14 (localization) moved into Phase 0.** Both can invalidate
  work done before they are answered.
- **`find_undocumented` reframed as a hypothesis**, not a proven differentiator.
  New Q15 defines the experiment that settles it.
- **`09-EVALUATION.md` added.** There was previously no way to tell whether the
  index helps an agent, and the token-savings claim was extrapolated from
  code-graph tools rather than measured.
- **Cold-start behaviour specified** for the MCP server (`06-CLI-UX.md`), which
  would otherwise have hung clients past their timeout on first use.
- **Concurrency addressed** (`03-ARCHITECTURE.md`), previously absent entirely.
- Schema fixes: edge primary key, epoch semantics, `logical_id` derivation made
  explicit as an open question rather than assumed.

Items marked 🔴 in `OPEN-QUESTIONS.md` gate real design decisions. Do not build past
them on assumption.

## Working agreements

- **Do not touch version control.** No `git init`, `git add`, `git commit`, branch
  creation, or any other VCS operation. The repository owner manages git manually.
- **Do not pause mid-run to ask questions.** If a blocker appears, append it to
  `OPEN-QUESTIONS.md` with enough context to be actionable, and continue with the
  next unblocked task.
- **Prefer verification over assumption.** If a `[ASSUMED]` fact can be checked by
  reading a local file, check it and update the document.
- When a document is contradicted by reality, **edit the document** as part of the
  same change. Stale specs are worse than no specs.
