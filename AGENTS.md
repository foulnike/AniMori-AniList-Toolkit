# AniMori Development Context

## Fast path

- Product: Vue 3 + TypeScript frontend, Tauri 2 Rust shell.
- Runtime layers: `src/app/` -> `src/shared/api/` -> `src/shared/bridge/`;
  `src/shared/core/` contains platform-independent data logic.
- Validate with `npm run build:app`; it includes `npm run typecheck:all`.
- Unit tests for pure core modules: `npm test` (vitest, no `@/` alias there).
- Use Codebase Memory for structure, call paths, impact, and symbol lookup
  before reading whole files.

## Context policy

Do not load all `docs/*.md` into context. Read only the document mapped to the
task below, and verify behavior against code:

| Task                                     | Read on demand                                  |
| ---------------------------------------- | ----------------------------------------------- |
| layers, imports, invariants, formatting  | `docs/CONVENTIONS.md`                           |
| repository branches and portability      | `docs/REPO-LAYOUT.md`                           |
| data flow, APIs, rate limits             | `docs/ARCHITECTURE.md`, `docs/DATA-PIPELINE.md` |
| UI screens and routing                   | `docs/ARCHITECTURE-UI.md`                       |
| Tauri, permissions, auth, proxy, release | `docs/ARCHITECTURE-SHELL.md`                    |
| storage, snapshot, XML export, cloud     | `docs/STORAGE-AND-SYNC.md`                      |
| dataset maintenance                      | `docs/DATASET-MAINTENANCE.md`                   |
| accepted design rationale                | `docs/DECISIONS.md`                             |
| planned work                             | `docs/ROADMAP.md`                               |
| video feature design                     | `docs/ARCHITECTURE-VIDEO.md`                    |

Prefer the smallest relevant code slice. Do not duplicate documentation in
comments or new files. Update a document only when current behavior changes.

## Change boundaries

- Network calls belong in `src/shared/api/`; screens do not call APIs directly.
- Tauri APIs are accessed through `src/shared/bridge/`.
- Keep `shared/` independent from `app/`.
- The list is one-way: nothing is ever written back to AniList. Data leaves the
  machine only by XML export or the cloud copy, and only on a user action.
- New external hosts require Tauri HTTP permission updates in
  `src-tauri/capabilities/default.json`.
- A new Tauri command means three places: `invoke_handler` in `lib.rs`, the
  `COMMANDS` list in `build.rs`, and an `allow-*` entry in the capabilities file.
- After edits, run the narrowest relevant check, then `npm run build:app`.
