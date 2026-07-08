# Zenos Memory Roadmap — Elite Agent Memory OS

**Updated:** 2026-07-05  
**Status:** Advanced production baseline implemented, deployed, and documented.

## Phase 1 — Embedding / Vector Search

Implemented:

- Deterministic 384-dimensional hashed embeddings
- Token and n-gram features
- Cosine vector search
- `/api/memory/vector`
- Neural-ready `/api/memory/embed` endpoint with deterministic fallback

Future upgrade:

- Configure a real embedding provider in the OpenAI-compatible router.

## Phase 2 — LLM Fact Extraction

Implemented:

- LLM extraction via `MEMORY_LLM_*`
- Structured JSON extraction
- Facts, preferences, decisions, tasks, artifacts, entities, contradictions, and credentials
- Deterministic fallback

## Phase 3 — Temporal Graph

Implemented:

- Memory nodes
- Entity nodes
- Credential nodes
- Weighted relationships
- Temporal `next` edges
- `mentions`, `related_to`, `supersedes`, `contradicts`, `credential_for`
- `/api/memory/graph`
- `/api/memory/graph-query`
- `/api/memory/graph-mermaid`

## Phase 4 — Concurrency Lock / Versioning

Implemented:

- Persistent lock lease audit endpoint
- Optimistic write/version hooks
- Expiring lock event memories
- `/api/memory/lock`

Future upgrade:

- Full Drive-backed lock queue with compare-and-swap semantics.

## Phase 5 — Memory Compaction Lifecycle

Implemented:

- LLM structured handoff
- Compaction memory records
- Bootstrap prioritization
- Multi-level architecture for session → topic → durable profile

## Phase 6 — Evals / Benchmark

Implemented:

- `/api/memory/eval`
- `/api/memory/benchmark`
- Regression cases for credential recall, context lifecycle, temporal graph, entity linking, maintenance, and handoff quality

## Phase 7 — Context Lifecycle System

Implemented:

- Capture → extract → compact → persist → recover
- Auto bootstrap on Hermes provider initialization
- Auto compact threshold in Hermes provider

## Phase 8 — Structured Handoff

Implemented:

- `current_goal`
- `active_state`
- `key_decisions`
- `user_preferences`
- `important_facts`
- `completed_work`
- `pending_work`
- `blockers`
- `files_artifacts`
- `recovery_instructions`
- `credentials`

## Phase 9 — Auto Compact Endpoint

Implemented:

- `/api/memory/compact`
- LLM-powered structured handoff
- Credential auto-extraction
- Drive persistence

## Phase 10 — Bootstrap Endpoint

Implemented:

- `/api/memory/bootstrap`
- Prioritizes recent compactions and relevant memories
- Returns context recovery block

## Phase 11 — Hermes Provider Auto-Trigger

Implemented:

- Auto bootstrap on initialize
- Auto compact every 20 turns
- Tools for compact, bootstrap, maintenance, dashboard, graph query, benchmarks, credentials, and merge planning

## Phase 12 — Cloud-Owned Agent Context OS

Implemented:

- Vercel API runtime
- Google Drive OAuth storage
- Etla HMAC protection
- Public dashboard and protected runtime
- No database vendor lock-in

## Phase 13 — Auto Compact + Bootstrap Recovery

Implemented:

- End-to-end compact and recovery loop
- Scheduler maintenance
- Benchmark and dashboard visibility

## Production Readiness

Zenos Memory is ready to use as production infrastructure for Hermes/Zenos.

Future work should be incremental improvements, not a rebuild:

- real embedding provider credentials
- graph visualization UI enhancements
- larger benchmark datasets
- stricter lock queue
- additional SDK integrations

---

## North Star Objective — LLM Intelligence Amplification

Zenos Memory exists to raise the effective intelligence of LLMs in the Zenos/Hermes ecosystem, especially lower-tier models. The goal is not to make a smaller model magically smarter internally; the goal is to surround every model with external cognitive infrastructure: persistent memory, compacted working context, retrieval, recovery, task continuity, tool/model routing support, and measurable evaluation.

This roadmap is the source of truth. Do not chase ad-hoc feature ideas unless they are first connected to this objective and recorded here.

## Core Principle

Every change must improve at least one intelligence-amplification capability:

- Recall: the model can retrieve important facts, preferences, decisions, files, and prior work.
- Continuity: the model preserves goals, tasks, blockers, and decisions across turns and sessions.
- Recovery: a new or reset session can bootstrap from compacted context and continue correctly.
- Retrieval quality: the model can find relevant memory/knowledge instead of hallucinating.
- Reasoning support: memory state clarifies what is current, superseded, contradicted, or unresolved.
- Verification: evals and benchmarks prove the behavior instead of relying on vibes.
- Safety: credentials and secrets are handled as protected metadata, not leaked context.
- Scope discipline: roadmap-first work prevents the agent from changing goals midstream.

## Active Build Target

Turn Zenos Memory from an advanced memory API into an Agent Context OS / LLM Intelligence Amplification Layer usable by multiple models in the ecosystem.

The immediate target is to verify and harden the compact -> bootstrap -> eval loop, because that loop is what lets lower-tier models recover context and act more capable than their raw context window would allow.

## Current Troubleshooting Findings — 2026-07-07

Observed from local repo, Hermes plugin, and production smoke test:

- Production public status is live: `https://zenos-memory.vercel.app/api/memory/public-status` returns HTTP 200.
- Production smoke suite passes with `npm run smoke:prod`: public-status, hybrid-recall, mutation-plan, timeline, episodes, and benchmark all pass; benchmark status is `elite-pass`.
- Local repo branch is `master`, last commit `206c600 Clarify public status evidence and dashboard CTAs`.
- Hermes plugin config exists at `/root/.hermes/profiles/zenos/zenos-memory.json` with base URL, secret, namespace, and auto-compact thresholds set.
- Environment has `ETLA_MASTER_SECRET`, `ZENOS_MEMORY_URL`, and `ZENOS_MEMORY_NAMESPACE` set, but `ZENOS_MEMORY_API_KEY` is not set in the current agent environment.
- The current Hermes tool wrapper used by this session reported `ZENOS_MEMORY_API_KEY is not configured` when calling `zenos_memory_remember`, while the plugin itself signs requests with `ETLA_MASTER_SECRET`. This suggests a split integration path: direct Hermes plugin config is present, but the exposed tool wrapper may require `ZENOS_MEMORY_API_KEY` or has not been wired to the HMAC config.
- Plugin auto-bootstrap exists in `/root/.hermes/profiles/zenos/plugins/zenos-memory/__init__.py` and calls `/api/memory/bootstrap` during initialize.
- Plugin auto-compact exists with thresholds: every 10 turns or at least 6000 chars, up to 80 recent messages.
- Plugin `on_pre_compress` calls `/api/memory/compact` before compression.

## Milestone Verification — 2026-07-07

Completed for the current intelligence-amplification milestone:

- Roadmap hardening completed: this file now defines the North Star Objective, Core Principle, Active Build Target, Definition of Done, and Anti Scope Drift Rules.
- Auth/integration troubleshooting completed: direct HMAC-signed production write to `/api/memory/remember` succeeded using the Hermes plugin config. The earlier `ZENOS_MEMORY_API_KEY is not configured` error is from a separate session tool wrapper path, not the deployed HMAC API path.
- Compact audit completed for the target gap: `/api/memory/compact` now normalizes/redacts message content before sending it to the LLM enhancer and redacts compact output before storage/return.
- Bootstrap eval coverage added: `app/lib/intelligence-eval.ts` verifies that compacted output can be rendered through `renderBootstrapBlock` as agent-ready recovery context.
- Intelligence eval coverage added: `/api/memory/benchmark` now includes `zenos-memory-intelligence-amplification-v3` cases for north-star preservation, roadmap discipline, pending work, bootstrap readiness, secret redaction, lower-tier bootstrap improvement, consumer-contract enforcement, and retrieval relevance.
- Production deploy completed: `https://zenos-memory.vercel.app` was aliased to the new deployment and signed production benchmark returns `zenos-memory-elite-regression-v9-intelligence-amplification`, `case_count: 16`, `score: 1`, `status: elite-pass`.

- Multi-case real LLM A/B endpoint added: `/api/memory/ab-eval` runs provider-backed with/without-bootstrap comparisons across continuation recovery, pending task recall, scope drift resistance, and secret safety when `MEMORY_LLM_*` is configured, otherwise reports a skipped state and points to deterministic benchmark baseline.

Remaining risks and follow-up backlog:

- The public status endpoint must stay aligned with benchmark evidence when benchmark names/case counts change.
- `npm run lint` still fails on pre-existing broad `no-explicit-any` lint debt across the repository; this milestone avoided introducing a new `any` in the touched compact route but did not clean the whole repo.
- `npm run build` succeeds, but Next config currently skips type and eslint validation (`ignoreBuildErrors` / `ignoreDuringBuilds`), so future hardening should include a separate type/lint cleanup milestone.
- The session-level `zenos_memory_remember` wrapper still needs a separate integration fix or config bridge if that exact tool path should write through HMAC instead of requiring `ZENOS_MEMORY_API_KEY`.
- Retrieval baseline is now covered by deterministic embedding relevance eval; real embedding provider or local embedding path remains future hardening after lifecycle reliability stays stable.

## Next Work Queue

1. Keep public evidence endpoints aligned with the deployed benchmark/intelligence-eval version and A/B endpoint.
2. Add a dedicated auth bridge fix for the session tool wrapper that requires `ZENOS_MEMORY_API_KEY`.
3. Add a type/lint cleanup milestone so build validation no longer depends on ignored errors.
4. Add real embedding provider or local embedding path after lifecycle reliability remains stable.
5. Document lower-tier model consumption patterns for memory, bootstrap, tools, and evaluator outputs.

## Definition of Done for Current Milestone

- Roadmap states the LLM intelligence amplification objective clearly.
- Current Zenos Memory health and integration issues are documented.
- The failing/misconfigured memory write path is understood and either fixed or recorded with a workaround.
- Compact -> bootstrap behavior is verified with concrete test data.
- Eval coverage includes at least one case proving a reset/lower-tier model can recover the active goal from Zenos Memory.
- No secrets are printed or stored as plain prompt context during tests.

## Anti Scope Drift Rules

- Do not propose new feature work until it maps to the North Star Objective.
- Do not treat endpoint existence as success; prove the endpoint improves recall, continuity, recovery, retrieval, verification, or safety.
- Do not replace the project or architecture unless the roadmap records why incremental improvement is insufficient.
- Do not rely on chat context alone for project direction; update this roadmap when priorities change.
- Do not store raw secrets in normal memories or final summaries.

## Production Ready Milestone

Status: complete for production-ready learning deployment. Gates: build pass, lint quiet pass, production smoke pass, benchmark elite-pass, real A/B eval positive, public status aligned, dashboard evidence updated, and `PRODUCTION_READINESS.md` added. Remaining future hardening is optional: stricter provider typing and neural embedding credentials.
