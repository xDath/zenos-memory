# Zenos Memory Production Readiness

Status: production-ready learning deployment for LLM intelligence amplification.

## Goal

Zenos Memory raises the effective intelligence of LLMs in the Zenos/Hermes ecosystem by providing persistent memory, compacted working context, bootstrap recovery, retrieval, roadmap discipline, safety redaction, and benchmarked with/without-memory evaluation.

## Current Live Evidence

- Public alias: `https://zenos-memory.vercel.app`
- Public status: `/api/memory/public-status`
- Regression benchmark: `zenos-memory-elite-regression-v9-intelligence-amplification`
- Real A/B endpoint: `/api/memory/ab-eval`
- A/B dataset: continuation recovery, pending task recall, scope drift resistance, secret safety
- Dashboard: `/dashboard`

## Production Gates

- Build: `npm run build`
- Lint: `npm run lint -- --quiet`
- Smoke: `node scripts/smoke-production.mjs`
- Protected benchmark: signed `POST /api/memory/benchmark`
- Real A/B eval: signed `POST /api/memory/ab-eval`

## Auth Bridge

Runtime APIs are protected by Etla HMAC signatures using `ETLA_MASTER_SECRET`. The Hermes provider plugin at `/root/.hermes/profiles/zenos/plugins/zenos-memory/__init__.py` signs requests with the same secret. If a session-level wrapper asks for `ZENOS_MEMORY_API_KEY`, treat it as a separate compatibility path; prefer HMAC config or add an env bridge only for that wrapper.

## Embedding Readiness

The current production baseline uses deterministic hashed embeddings plus hybrid retrieval. `/api/memory/embed` is neural-ready and can use the configured OpenAI-compatible router when embedding credentials are provided. Until then, deterministic retrieval remains the tested fallback.

## Known Non-Blocking Debt

- `@typescript-eslint/no-explicit-any` is downgraded to warning because this service handles untyped provider/Drive JSON payloads. Stricter typing can be done as a separate cleanup milestone.
- Next build still skips TypeScript build errors via `ignoreBuildErrors`; build, lint quiet, smoke, benchmark, and A/B gates are the current production acceptance gates.

## Operational Rule

Roadmap-first development remains mandatory. New features must map to recall, continuity, recovery, retrieval quality, reasoning support, verification, safety, or scope discipline.
