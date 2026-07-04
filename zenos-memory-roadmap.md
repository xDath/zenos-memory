# Zenos Memory Roadmap — Top Tier Agent Memory OS

Updated: 2026-07-04
Status: Previous Phase 0-5 is considered implemented and archived. This roadmap replaces the old roadmap.

## Vision

Zenos Memory is not just a memory CRUD API. It is a cloud-owned agent context operating system for Hermes/Zenos:

- Google Drive-only ownership via OAuth, using the user's Drive quota.
- Structured Drive storage that can create/edit folders and JSON files.
- Etla-only signed access.
- Default Hermes memory provider.
- Long-context compression, bootstrap recovery, semantic recall, and structured handoff.
- Portable across machines because the memory state lives in cloud-owned Drive.

## Current Baseline

Already working:

- Production Vercel app: `https://zenos-memory.vercel.app`
- GitHub private repo: `xDath/zenos-memory`
- Google Drive OAuth mode with structured storage support
- Etla HMAC signature auth
- Hermes profile `zenos` default provider: `zenos-memory`
- Remember / recall / profile / report / graph / health endpoints
- Advanced schema: entities, contradictions, supersedes_ids, access_count, last_accessed_at
- Drive write/read/search tested successfully with OAuth

## Architecture Target

```text
Hermes / Zenos agent
  -> thin provider
  -> Etla signed HTTPS
  -> Zenos Memory API on Vercel
  -> Lite memory agent / LLM worker
  -> Google Drive structured storage

Google Drive structure:
zenos-memory/
  namespaces/
    zenos/
      memories.json
      entities.json
      relationships.json
      profile.json
      audit.json
      compactions.json
      indexes.json
      tasks.json
      decisions.json
      artifacts.json
      evals.json
```

## Lite Memory Agent

Goal: deploy a small reasoning worker on Vercel to manage memory lifecycle.

Responsibilities:

- Compact long sessions into structured handoff blocks.
- Extract durable facts, preferences, decisions, tasks, artifacts, and blockers.
- Generate embeddings or semantic fingerprints.
- Update temporal graph.
- Run dedup/merge/conflict logic.
- Produce bootstrap context for new or compressed sessions.

Model strategy:

- Use a cheap/lite model for compaction and extraction.
- Keep deterministic fallback if model API fails.
- Store raw source excerpts/provenance so compaction is auditable.
- Do not send secrets; redact env/token patterns before model calls.

Candidate envs:

```text
MEMORY_LLM_PROVIDER=openrouter|openai|xai|none
MEMORY_LLM_MODEL=<cheap-model>
MEMORY_LLM_API_KEY=...
MEMORY_LLM_MAX_TOKENS=2000
MEMORY_LLM_TIMEOUT_MS=20000
```

## Phase 1 — Context Lifecycle System

Status: Next priority

Deliverables:

- `POST /api/memory/compact`
  - input: session messages, namespace, session_id, approx_tokens, reason
  - output: structured compact snapshot
  - writes to `compactions.json`

- `POST /api/memory/bootstrap`
  - input: namespace, queries, current goal
  - output: compact latest + relevant memories + active tasks + decisions
  - ready to inject into Hermes context/system prompt

- Compact format:
  - Current Goal
  - Active State
  - Key Decisions
  - User Preferences
  - Important Facts
  - Completed Work
  - Pending Work
  - Blockers
  - Files / Artifacts
  - Recovery Instructions

- Store provenance:
  - session_id
  - message_count
  - approx_tokens
  - source ranges
  - created_at
  - compaction level

Acceptance tests:

- Long fake conversation produces compact snapshot under max_chars.
- Bootstrap endpoint returns compact + top memories.
- No secret patterns leak into compact output.

## Phase 2 — Hermes Provider Auto Trigger

Deliverables:

- Provider tracks turn count / approx chars / approx tokens.
- Auto compact when threshold is exceeded.
- Auto bootstrap during provider initialize.
- Tools exposed:
  - `zenos_memory_compact`
  - `zenos_memory_bootstrap`
  - `zenos_memory_profile`

Proposed thresholds:

```yaml
compact_after_turns: 20
compact_after_chars: 60000
compact_after_tokens: 12000
bootstrap_on_initialize: true
```

Acceptance tests:

- Provider can call compact endpoint.
- Provider receives bootstrap block after initialize.
- Current session can continue after compaction without losing active state.

## Phase 3 — LLM Fact Extraction

Deliverables:

- Lite model extraction endpoint:
  - `POST /api/memory/extract`
- Extract categories:
  - facts
  - preferences
  - decisions
  - tasks
  - relationships
  - artifacts
  - contradictions
- Rule-based fallback when model fails.
- Confidence scoring and source provenance.

Acceptance tests:

- Extracts user preferences from noisy conversation.
- Extracts active tasks and decisions.
- Does not store low-signal chatter.

## Phase 4 — Embedding / Vector Search

Deliverables:

- Add embedding field or semantic fingerprint per memory.
- Store indexes in `indexes.json`.
- Hybrid retrieval:
  - keyword score
  - embedding cosine score
  - recency
  - importance
  - access count
  - graph proximity
- Endpoint:
  - `POST /api/memory/search-advanced`

Implementation options:

- External embedding API for quality.
- Local hashing/minhash fallback for no-cost mode.

Acceptance tests:

- Semantic query finds relevant memory without exact keyword.
- Hybrid ranking beats current keyword scoring on test cases.

## Phase 5 — Temporal Graph

Deliverables:

- `entities.json`
- `relationships.json`
- entity extraction and normalization
- relationship edges with timestamps and provenance
- temporal update semantics:
  - supersedes
  - contradicts
  - reinforces
  - related_to
- Endpoint:
  - `GET /api/memory/graph/search`

Acceptance tests:

- Can answer relationship/history queries.
- Contradicting preference updates old memory instead of duplicating blindly.

## Phase 6 — Concurrency Locking & Versioning

Deliverables:

- Drive lock file:
  - `locks.json`
- Optimistic versioning:
  - read version
  - write if version unchanged
  - retry/merge on conflict
- Version history per memory.
- Audit log for write/edit/forget/compact.

Acceptance tests:

- Two simultaneous writes do not corrupt JSON.
- Failed write retries safely.

## Phase 7 — Memory Compaction Lifecycle

Deliverables:

- Multi-level compaction:
  - L0 raw recent memories
  - L1 session compact
  - L2 topic compact
  - L3 durable profile / project state
- Decay/archive low-value memories.
- Merge duplicates into canonical facts.
- Keep source references.

Acceptance tests:

- 100+ messages compact into concise handoff.
- Old compactions merge into topic summaries.
- Bootstrap remains under target char/token budget.

## Phase 8 — Evals & Benchmarks

Deliverables:

- `evals.json`
- test conversations
- benchmark script for:
  - recall accuracy
  - extraction precision
  - compaction faithfulness
  - bootstrap usefulness
  - token savings
- Compare against baseline keyword retrieval and Mem0-like expectations.

Acceptance tests:

- Reports accuracy and token savings.
- Regression tests run locally before deploy.

## Phase 9 — Production Hardening

Deliverables:

- Remove debug endpoint or protect it behind admin-only flag.
- Better logs without leaking secrets.
- Rate limits per endpoint.
- Error messages actionable but safe.
- Drive OAuth token rotation procedure.
- Backup/export schedule.

Acceptance tests:

- No secret in logs/responses.
- All endpoints return clear errors.
- Production deploy passes smoke tests.

## Immediate Next Steps

1. Implement robust structured compaction and bootstrap outputs.
2. Add Hermes provider auto-trigger for compact/bootstrap.
3. Add lite LLM extractor with deterministic fallback.
4. Add Drive lock/versioning before heavy concurrent use.
5. Add eval fixtures and smoke tests.

## Definition of Top Tier

Zenos Memory reaches top tier when it can:

- Remember long-term facts/preferences/tasks reliably.
- Compact long sessions automatically without losing active state.
- Bootstrap a new session with enough context to continue work.
- Retrieve semantically, not only by exact keyword.
- Maintain temporal graph/history of decisions and relationships.
- Avoid JSON corruption under concurrent writes.
- Prove quality through evals/benchmarks.
- Stay fully owned by the user through Google Drive OAuth.
