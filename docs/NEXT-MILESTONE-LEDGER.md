# Next milestone execution ledger

Updated: 2026-09-11. Integration worktree: `next-milestone-integration` at orchestration record `2de9dcc`, preserving accepted P0-P3/P9 work and the transferred source working-tree changes. Orca run: `run_4e43ac50f8e8`.

## Package state

| Item | Orca task | State | Owner | Dependency evidence | Change/evidence | Outstanding |
| --- | --- | --- | --- | --- | --- | --- |
| P0 | `task_f6b628cd3920` | accepted | agy `ctx_0f2653834e31`, corrections `ctx_f33979ba3af7` / `ctx_94e380835b16`, orchestrator review | none | frozen contracts and fixtures; targeted 76/76; full 646/646; check/build clean; host and Docker Node 24 `fs-ext` proof passed | — |
| G0 | `task_20644ffca4b1` | passed | orchestrator | P0 | contract matrix, exact migration sequence, lifecycle/lock choice, truthful aggregate/freshness/catch-up failure cases reviewed | — |
| P1 | `task_7d721f095348` | accepted | agy plus semantic-identity correction `ctx_4b9d0434c236`; orchestrator review | G0 | schema/repositories integrated through `4a30d81`; migration 009 completes the five-part slice/allocation key; independent DB/repository tests 69/69; migration rollback, IDs, FKs, detached state and audit history reviewed | none |
| P2 | `task_e82c1a05fdde` | accepted | agy `ctx_186b85a6dc5c`, corrections `ctx_8d90f9c5c7bd` / `ctx_33633646a73b` / `ctx_fb285094c601`; orchestrator review | G0 | transport/OAuth integrated at `53ee159`; independent targeted 125/125; worker full 771/771, check/build clean; shared pacing, truthful Retry-After, generation CAS/ABA, caller cancellation, and whole-operation deadline verified | none |
| P3 | `task_f36f1547ac48` | accepted | agy Stage A/B and bounded corrections; orchestrator review/final residual integration | P1, P2 | source-faithful adapters and transactional reconciliation merged at `d83a5c7`; 236/236 targeted and 867/867 full tests; check/build clean; exact raw lineage, fail-closed fidelity, membership, allocation preservation, and post-commit cache paths reviewed | none |
| G1 | `task_62f0c41edff7` | passed | orchestrator | P1, P2, P3 | 400/400 targeted integration tests; 867/867 full tests; check/build clean; migrations, replay, dump compatibility, transport bounds, allocations, evidence and coarse classification reviewed | none |
| P4 | `task_0fc56bbe5b41` | in_progress | agy `term_8d2c36b7-5124-49d7-bc97-933f00caaeea`; child `task_60dc17062ecc` | G1 | Dispatch `ctx_c076a3d8ae9b`; worktree `.worktrees/work-times/p4-registry` at accepted `e7321cd` | Implementation and validation pending |
| P5 | `task_c0a4eaa891b2` | in_progress | agy `term_21efbee0-88c8-4713-9686-f07d4b819e11`; child `task_822d2c372bb0` | G1 | Dispatch `ctx_3196158ca32f`; worktree `.worktrees/work-times/p5-day-worker` at accepted `e7321cd` | Implementation and validation pending |
| P6 | `task_13c534fd95f1` | prepared | child `task_03fe209b2544`; unassigned | P5 | Bounded coordinator brief frozen with dependency on P5 child `task_822d2c372bb0` | Await accepted P5 integration state before worktree and dispatch |
| G2 | `task_b07a775ae59f` | pending | orchestrator | P4, P6 | pending | Gate review |
| P7 | `task_62ede9b2f4ce` | prepared | child `task_1056c9aa6c84`; unassigned | G2 | Bounded scheduler/runtime brief frozen; dependency on G2; fs-ext already pinned by orchestrator | Await G2 before worktree and dispatch |
| P8 | `task_ea65af005d18` | prepared | backend child `task_cdd4fe996bcc`; UI/browser child `task_3c1be5088f4b`; unassigned | G2, then P8A before P8B | Bounded sequential briefs freeze service/API/quality ownership before UI/browser integration | Await G2 before P8A worktree and dispatch |
| P9 | `task_db905eeaa75e` | accepted | agy `ctx_93af6b374108`, corrections `ctx_7527bef826b0`; orchestrator review | G0 | client-specific recipes and safe metadata integrated at `3a152d8`; independent targeted 43/43; worker full 689/689, check/build clean; Orca production-build smoke verified Codex, Claude Code, and Claude Desktop OAuth recipes | Full G3/G4 synthetic mobile and clipboard-failure evidence remains |
| G3 | `task_9ce29b4e96a0` | pending | orchestrator | P7, P8, P9 | pending | Gate review |
| P10 | `task_1a44fbdba0ee` | prepared | evidence child `task_15fbcd5edf05`; docs child `task_8490d317c298`; unassigned | G3, then P10A before P10B | Local integration/process/browser evidence is separated from accurate release documentation | Await G3 before worktree and dispatch |
| G4 | `task_25831a75f534` | pending | orchestrator | P10 | pending | Live checks may remain explicitly unavailable |

## Frozen coordination facts

- Source dirty baseline transferred byte-for-byte: `docs/IMPLEMENTATION-PLAN.md`, `docs/NEXT-MILESTONE.md`, `docs/NEXT-MILESTONE-REVIEW.md`, and `src/routes/admin/classify/+page.svelte`.
- No repository `AGENTS.md` files were present.
- Shared-file order: P1 owns migrations/repositories; `classification/sqlite.ts` passes P3 → P4 → P8; P7 owns runtime/hooks/server; P9 owns `AppShell.svelte`; dependency and lockfile changes route through the orchestrator.
- Maximum three concurrent coding workers. No production writes, deployment, scheduling enablement, live database migration, push, or publication.
- Agy launch contract: use `agy --mode accept-edits` explicitly for every worker; retain the configured Gemini model and permission controls.

## Gate evidence

| Gate | Status | Evidence |
| --- | --- | --- |
| G0 | passed | P0 integrated at `ab9297f`, gate record `7f35134`; 76 targeted and 646 full tests passed; typecheck and in-memory build clean; unsupported shapes retain/reject without fabricated duration, identity, completeness, or success. |
| G1 | passed | P1-P3 integrated through `d83a5c7`; targeted gate 400/400 and full suite 867/867 passed; `pnpm check` reported no errors/warnings; in-memory build succeeded. Direct review found no data loss, additive polling, invalid FK/trigger behavior, or widened work classification under missing evidence. |
| G2 | pending | — |
| G3 | pending | — |
| G4 | pending | — |

P0 first-pass review kept G0 pending: direct review found migration filename drift, a missing documented `DETAIL_DOWNGRADE` constant, success aggregation that ignored preserved/rejected dispositions, incomplete stale-state handling, and a startup selector without retryable/unfinished inputs. Bounded correction task: `task_1f0e194dcd0e` / `ctx_f33979ba3af7`.
- 2026-09-09 G0: P0 accepted after two supervised correction passes and a final orchestrator fix that defers corrupt retry metadata and excludes future recovery dates. Integration verification passed 646 tests in 36 files, `pnpm check` with 0 errors/warnings, and `DATABASE_PATH=:memory: pnpm build`.

## Verification log

- 2026-09-09 baseline at `9c00d70`: `pnpm test` passed 570 tests in 34 files; `pnpm check` reported 0 errors and 0 warnings; `pnpm build` completed successfully with the in-memory database build contract.
- 2026-09-10 P9: accepted after a bounded correction pass. Independent recipe/page tests passed 43/43; exact Codex and Claude recipes, fail-closed expiry handling, safe key metadata, accessible selection, and cleanup paths were reviewed. Integrated at `3a152d8`.
- 2026-09-10 P1: accepted after boundary corrections. Independent repository/migration tests passed 62/62; populated migration, scoped restart recovery, unchanged-content freshness, exact heartbeat retirement, allocation survival, and atomic connection-generation CAS were reviewed. Integrated at `9105de7`; the historical consolidation test now expects migrations 005-008 and passes 24/24.
- 2026-09-10 P3A dispatch: Orca readiness detection rejected two attachment attempts after the one-time folder trust screen; manual Orca dispatch `ctx_32c1687d895a` injected the same bounded task into the verified `agy --mode accept-edits` terminal. No implementation ran under the failed attachments.
- 2026-09-11 P2: accepted after three bounded correction passes. Independent transport/OAuth/schema/capability/discovery tests passed 125/125; one shared paced request gate, full Retry-After, 5-minute whole-operation budget, 30-second per-request/body bound, cancellation, sanitization, and P1 generation CAS/ABA behavior were directly reviewed. Integrated at `53ee159`; worker full 771/771, check and in-memory build clean.
- 2026-09-11 P1 semantic identity: migration 009 and repository support accepted at worker commit `90470ba`, frozen contract correction `97cab21`, and integration merge `4a30d81`; independent DB/repository tests passed 69/69.
- 2026-09-11 P8/P10 browser preparation: confirmed repository Playwright 1.63.0 and installed its matching Chromium 1243 plus headless shell into the local cache from the Orca integration terminal; no tracked files changed.
- 2026-09-11 P7 dependency preparation: orchestrator pinned `fs-ext@2.1.1` and `@types/fs-ext@2.0.3`, allowlisted only the required native build, verified exclusive lock/unlock on Node 24, reproduced `pnpm install --frozen-lockfile`, ran a clean `pnpm check`, and passed the full 867/867 suite. Runtime files remain owned by P7.
- 2026-09-11 P4/P5 dispatch: both bounded tasks were injected into verified `agy --mode accept-edits` sessions at `e7321cd`; Gemini quota stopped both before any file write. Both retained exact-mode sessions resumed after reset with conversation-scoped Orca command permission; implementation is active.
- 2026-09-11 P9 Orca browser smoke: a production build served with an isolated test database and matching `PUBLIC_URL` authenticated successfully. The MCP page exposed accessible client/auth radio groups, exact Codex TOML and Claude Code JSON recipes, a truthful no-key state, Claude Desktop bearer rejection, and the OAuth remote-connector recipe with public-HTTPS guidance.
- 2026-09-11 P3/G1: P3 merged at `d83a5c7` after supervised agy implementation and orchestrator residual corrections. Targeted P3 tests passed 236/236; G1 migration/repository/import/reconciliation/classification/transport tests passed 400/400; full suite passed 867/867; check and in-memory build were clean. Raw transport lineage is distinct from normalized content, unchanged checks advance freshness without snapshot inflation, degraded evidence remains partial, detached allocations survive but legacy lookup fails closed, and missing detailed projects preserve the accepted snapshot.
- 2026-09-11 P7/P8 preparation: froze P7 child `task_1056c9aa6c84` and split P8 into sequential backend/API/quality child `task_cdd4fe996bcc` and UI/browser child `task_3c1be5088f4b`; all remain dependency-blocked until G2.
- 2026-09-11 P10 preparation: froze local evidence child `task_15fbcd5edf05` and sequential operations/documentation child `task_8490d317c298`; both remain dependency-blocked until G3.
