# Plan

**This is a living document.** Milestones will be re-scoped, re-ordered, split, or
added as planning conversations and findings come in. That churn is expected; what is
*not* allowed is silent change. Scope changes get a decision-log entry; progress is
reflected here by checking boxes and updating status lines as work lands.

Check a box only when the item is done and verified; partially done items stay
unchecked, optionally with a note.

**Status legend:** `pending` · `in progress` · `done` · `parked`

## M0 — Plan the plan  `in progress`

Goal: turn the initial feature list into a settled vision, feature matrix,
architecture, and milestone ladder — through planning conversations with the project
owner plus targeted research/spikes where a decision needs evidence.

- [x] Repo scaffolding for the AI-directed workflow: AGENTS.md, CLAUDE.md, docs/
      (vision, features, plan, architecture, decisions, rough-edges, workflow).
- [ ] Feature triage: walk [features.md](features.md) with the project owner; promote
      or reject every `proposed` row; answer the open questions; record the
      significant calls in [decisions.md](decisions.md).
- [ ] Runtime/backend survey (current sources, not training knowledge — root rule 4):
      for each candidate runtime (wllama, transformers.js, WebLLM, MediaPipe,
      ONNX Runtime Web, Prompt API, others discovered), document version, formats,
      backends, threading/isolation requirements, multimodal and structured-output
      support, license, and maintenance health. Output: a comparison table feeding
      architecture.md and the runtime-adapter design.
- [ ] Hosting-constraints spike: COOP/COEP options on meenan.dev static hosting vs.
      Hugging Face CORS behavior (downloads + API), `/webai/` base path, header
      configuration for the rsync deploy target, and the shared-origin storage
      question (OPFS/IndexedDB/quota are origin-scoped — path vs. dedicated origin).
      Output: decisions on the isolation strategy and the origin (features.md open
      questions 1 and 8).
- [ ] Hugging Face API spike: search/filter capabilities of the public REST API from
      a browser client (rate limits, CORS, what "browser-suitable" filters are
      actually expressible), LFS metadata for integrity/resume.
- [ ] First full draft of [architecture.md](architecture.md): runtime adapter
      abstraction, worker topology, storage layout, download manager, capability
      gating, benchmark harness design.
- [ ] Toolchain decisions: Astro version + islands framework (React? Svelte? none?),
      package manager, test stack (unit + e2e), lint/format, CI, license audit.
      Record in decisions.md.
- [ ] UI/design direction: look-and-feel brief for the "slick chat UI", theming
      (light/dark), design-token approach; decide whether a Design.md (golemine-style
      design system doc) is warranted from M1.
- [ ] Rewrite the provisional ladder below into real milestones with exit criteria.

**Exit criteria:** every checklist item above is checked; every `proposed` row in
features.md is resolved **and every features.md open question answered**, with
decision-log entries for the significant calls; architecture.md first draft reviewed;
toolchain decided; M1+ milestones have scopes and exit criteria. Nothing on this list
is optional — M0 is not done while any item above remains open.

## Provisional milestone ladder  `pending — to be rewritten in M0`

Ordered by risk: platform substrate and one working end-to-end path before breadth.
Sketch only — do not start work from these entries, and note that they freely
reference `proposed` features.md rows; nothing here pre-empts the M0 triage.

- **M1 — Scaffolding & shell.** Astro project with base path, strict TS, tests, CI,
  license audit, deploy script (build + rsync dry-run), capability-report page as the
  first real feature (it exercises the gating layer everything else needs).
- **M2 — Models.** HF search/browse/filter, download manager (progress, resume,
  integrity), OPFS model store + management UI, user import, GGUF metadata inspection.
- **M3 — First chat.** Chat UI with streaming, system prompt, generation params, one
  runtime end-to-end (likely wllama single-thread as lowest-common-denominator, or
  transformers.js — decide in M0).
- **M4 — Runtime breadth.** Runtime adapter layer proven by adding the runtimes
  selected in the M0 survey, incl. the Prompt API (with its browser-managed download
  flow); per-runtime capability gating; side-by-side comparison if confirmed.
- **M5 — Tooling.** gguf-split wasm build + split/merge UI; sharded model handling
  end-to-end.
- **M6 — Benchmarking.** Dataset config, metric capture, iterations/statistics,
  results history + export.
- **M7 — Multimodal.** Image input for supporting runtimes/models; Prompt API
  multimodal.
- **M8 — Polish & launch.** Design polish, docs/guides, cross-browser pass, PWA if
  confirmed.
