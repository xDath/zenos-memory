const capabilities = [
  ['Serverless event core', 'Immutable Drive events, deterministic IDs, cursor ordering, and per-namespace CAS write leases.', 'STATE'],
  ['Context continuity', 'Structured compact snapshots and bounded bootstrap packets survive context resets.', 'RECOVERY'],
  ['Hybrid retrieval', 'Warm SQLite FTS5 materialization, deterministic vector signals, graph evidence, recency, and lifecycle ranking.', 'RECALL'],
  ['Temporal lifecycle', 'Active, superseded, and archived states with validity windows and source provenance.', 'TIME'],
  ['Evidence graph', 'Entities, sources, chunks, explicit relations, contradictions, and supersession edges.', 'GRAPH'],
  ['Secret boundary', 'Raw credentials are rejected. Memory may retain external vault references only.', 'SAFETY'],
  ['Scoped access', 'Anti-replay HMAC token exchange issues short-lived read, write, or admin tokens.', 'AUTH'],
  ['Verified recovery', 'Drive snapshots, search indexes, and graph indexes are immutable, checksummed, and re-read before success.', 'BACKUP'],
  ['Operational control', 'Drive CAS leases, Vercel Cron compaction, health gates, cloud audit events, and cold-start smoke tests.', 'OPS'],
];

const lifecycle = [
  ['01', 'Capture', 'Receive a durable fact, decision, task, artifact, or structured conversation handoff.'],
  ['02', 'Validate', 'Reject malformed input and raw secrets before data reaches persistent storage.'],
  ['03', 'Append', 'Deduplicate, link, supersede, or archive as one immutable, checksummed cloud event.'],
  ['04', 'Retrieve', 'Rank current evidence across lexical, vector, graph, quality, and recency signals.'],
  ['05', 'Recover', 'Rebuild a compact working context with source IDs instead of replaying an entire chat.'],
  ['06', 'Compact', 'Vercel Cron writes a verified snapshot plus portable search and graph indexes into the user-owned Drive.'],
];

const interfaces = [
  ['POST', '/api/auth', 'Exchange an anti-replay HMAC signature for a short-lived scoped token.'],
  ['POST', '/api/memory/remember', 'Store one validated, idempotent memory mutation.'],
  ['POST', '/api/memory/hybrid-recall', 'Retrieve current evidence with hybrid lifecycle ranking.'],
  ['POST', '/api/memory/compact', 'Create a redacted, structured handoff from conversation turns.'],
  ['POST', '/api/memory/bootstrap', 'Assemble a bounded recovery packet from durable context.'],
  ['GET', '/api/memory/graph', 'Project evidence-backed temporal and provenance relationships.'],
  ['POST', '/api/memory/backup', 'Create and verify a durable snapshot.'],
  ['POST', '/api/memory/restore', 'Verify checksum, then merge or replace snapshot data.'],
  ['POST', '/api/memory/lock', 'Acquire, renew, or release a transactional lease.'],
  ['GET', '/api/memory/health-check', 'Return authenticated readiness and data-quality evidence.'],
];

function MemoryOrbit() {
  return (
    <div className="relative mx-auto aspect-square w-full max-w-[34rem]">
      <div className="absolute inset-[9%] rounded-full border border-emerald-200/15" />
      <div className="absolute inset-[21%] rounded-full border border-cyan-200/20" />
      <div className="absolute inset-[34%] rounded-full border border-lime-200/25" />
      <div className="absolute inset-[39%] grid place-items-center rounded-full border border-white/15 bg-[#0c1512]/95 shadow-[0_0_90px_rgba(52,211,153,0.18)] backdrop-blur-xl">
        <div className="text-center">
          <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-emerald-200 text-2xl font-black text-[#07110d]">Z</div>
          <div className="mt-4 text-lg font-black">Cloud Event Core</div>
          <div className="mt-1 font-mono text-[11px] uppercase tracking-[0.24em] text-emerald-200/70">serverless</div>
        </div>
      </div>
      {[
        ['Recall', 'left-[2%] top-[42%]'],
        ['Graph', 'right-[3%] top-[18%]'],
        ['Compact', 'left-[18%] top-[6%]'],
        ['Vault refs', 'right-[2%] bottom-[25%]'],
        ['Backup', 'left-[16%] bottom-[5%]'],
        ['Audit', 'right-[24%] bottom-[3%]'],
      ].map(([label, position]) => (
        <div key={label} className={`absolute ${position} rounded-full border border-white/10 bg-white/[0.055] px-4 py-2 text-xs font-bold text-zinc-200 shadow-xl backdrop-blur-xl`}>
          {label}
        </div>
      ))}
    </div>
  );
}

export default function Dashboard() {
  return (
    <main className="min-h-screen overflow-hidden bg-[#050806] text-[#f3faf5]">
      <div className="pointer-events-none fixed inset-0">
        <div className="absolute left-[-12rem] top-[-12rem] h-[36rem] w-[36rem] rounded-full bg-emerald-500/15 blur-[120px]" />
        <div className="absolute right-[-12rem] top-[16%] h-[34rem] w-[34rem] rounded-full bg-cyan-400/10 blur-[130px]" />
        <div className="absolute bottom-[-18rem] left-[28%] h-[38rem] w-[38rem] rounded-full bg-lime-400/10 blur-[140px]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.035)_1px,transparent_1px)] bg-[size:28px_28px] [mask-image:linear-gradient(to_bottom,black,transparent_88%)]" />
      </div>

      <section className="relative mx-auto max-w-7xl px-5 py-6 md:px-8 md:py-9">
        <nav className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/[0.035] px-4 py-3 backdrop-blur-2xl md:px-5">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-emerald-200 font-black text-[#06110c]">Z</div>
            <div>
              <div className="font-black tracking-tight">Zenos Memory</div>
              <div className="text-xs text-zinc-500">context continuity infrastructure</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden rounded-full border border-emerald-200/15 bg-emerald-200/[0.06] px-3 py-1.5 text-xs text-emerald-100 md:inline-flex">v2.0 cloud-native</span>
            <a href="/api/memory/public-status" className="rounded-xl border border-white/10 px-3 py-2 text-xs font-bold text-zinc-200 transition hover:border-emerald-200/30 hover:bg-emerald-200/[0.06]">Capability JSON</a>
          </div>
        </nav>

        <section className="grid min-h-[42rem] items-center gap-8 py-14 lg:grid-cols-[1.08fr_0.92fr] lg:py-20">
          <div>
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-emerald-200/15 bg-emerald-200/[0.06] px-4 py-2 text-xs font-bold uppercase tracking-[0.24em] text-emerald-100">
              <span className="h-2 w-2 rounded-full bg-emerald-300 shadow-[0_0_18px_rgba(110,231,183,0.9)]" />
              User-owned memory fabric
            </div>
            <h1 className="max-w-4xl text-6xl font-black leading-[0.88] tracking-[-0.065em] sm:text-7xl lg:text-[6.4rem]">
              Context should age.
              <span className="block bg-gradient-to-r from-emerald-200 via-lime-100 to-cyan-200 bg-clip-text text-transparent">Not disappear.</span>
            </h1>
            <p className="mt-7 max-w-2xl text-lg leading-8 text-zinc-300">
              Zenos Memory turns agent context into a serverless, user-owned event stream: current facts, superseded decisions,
              provenance, compact recovery packets, evidence graphs, and verified Drive snapshots—without loading the VPS.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a href="#architecture" className="rounded-2xl bg-emerald-200 px-5 py-3 font-black text-[#06110c] transition hover:bg-emerald-100">Explore architecture</a>
              <a href="#interfaces" className="rounded-2xl border border-white/12 bg-white/[0.04] px-5 py-3 font-bold text-white transition hover:bg-white/[0.08]">Inspect API surface</a>
            </div>
            <div className="mt-10 grid max-w-2xl grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ['Drive', 'canonical event store'],
                ['Vercel', 'scale-to-zero compute'],
                ['HMAC v2', 'anti-replay auth'],
                ['SHA-256', 'verified snapshots'],
              ].map(([metric, label]) => (
                <div key={metric} className="rounded-2xl border border-white/9 bg-white/[0.035] p-4 backdrop-blur-xl">
                  <div className="font-mono text-xl font-black text-emerald-100">{metric}</div>
                  <div className="mt-1 text-xs leading-5 text-zinc-500">{label}</div>
                </div>
              ))}
            </div>
          </div>
          <MemoryOrbit />
        </section>

        <section id="architecture" className="scroll-mt-8 rounded-[2rem] border border-white/10 bg-[#09100d]/80 p-6 shadow-2xl shadow-black/30 backdrop-blur-2xl md:p-8">
          <div className="grid gap-7 lg:grid-cols-[0.75fr_1.25fr]">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.28em] text-emerald-200">Architecture contract</p>
              <h2 className="mt-3 text-4xl font-black tracking-[-0.04em]">One job, done deeply.</h2>
              <p className="mt-4 leading-7 text-zinc-400">
                Memory owns durable context and retrieval. Vercel performs compute, Google Drive owns the append-only canonical history, and the VPS remains a thin Hermes client. Runtime orchestration stays separate.
              </p>
              <div className="mt-6 rounded-2xl border border-amber-200/15 bg-amber-100/[0.045] p-4 text-sm leading-6 text-amber-50/80">
                Raw passwords, API keys, tokens, cookies, and private keys are rejected before persistence. Store them in a real vault; Zenos keeps only the reference.
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {capabilities.map(([title, description, label]) => (
                <article key={title} className="rounded-2xl border border-white/9 bg-white/[0.028] p-5 transition hover:-translate-y-0.5 hover:border-emerald-200/25 hover:bg-emerald-200/[0.035]">
                  <div className="font-mono text-[10px] font-black tracking-[0.22em] text-emerald-200/65">{label}</div>
                  <h3 className="mt-3 font-black text-zinc-50">{title}</h3>
                  <p className="mt-2 text-sm leading-6 text-zinc-500">{description}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="py-16">
          <div className="mb-7 max-w-3xl">
            <p className="text-xs font-black uppercase tracking-[0.28em] text-cyan-200">State lifecycle</p>
            <h2 className="mt-3 text-4xl font-black tracking-[-0.04em] md:text-5xl">From noisy conversation to recoverable evidence.</h2>
          </div>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {lifecycle.map(([number, title, description]) => (
              <article key={number} className="group rounded-3xl border border-white/9 bg-white/[0.025] p-5 transition hover:border-cyan-200/20 hover:bg-cyan-200/[0.025]">
                <div className="flex items-start gap-4">
                  <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl border border-cyan-200/15 bg-cyan-200/[0.06] font-mono text-sm font-black text-cyan-100">{number}</div>
                  <div>
                    <h3 className="text-lg font-black">{title}</h3>
                    <p className="mt-2 text-sm leading-6 text-zinc-500">{description}</p>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section id="interfaces" className="scroll-mt-8 grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="rounded-[2rem] border border-white/10 bg-gradient-to-br from-emerald-200/[0.08] to-transparent p-7">
            <p className="text-xs font-black uppercase tracking-[0.28em] text-emerald-200">Trust model</p>
            <h2 className="mt-3 text-4xl font-black tracking-[-0.04em]">Proof over adjectives.</h2>
            <p className="mt-4 leading-7 text-zinc-400">
              Production status comes from executable gates: strict type checking, zero-warning lint, unit and security tests, Vercel builds, authenticated API smoke tests, real Drive CAS leases, immutable-event cold starts, and verified snapshot reads.
            </p>
            <div className="mt-7 space-y-3 font-mono text-sm">
              {[
                ['npm run check', 'source + contract gates'],
                ['npm run smoke:cloud', 'real Drive event + cold-start gate'],
                ['/api/memory/benchmark', 'live dependency gates'],
                ['/api/memory/health-check', 'readiness + data quality'],
                ['/api/memory/ab-eval', 'optional live-model comparison'],
              ].map(([command, label]) => (
                <div key={command} className="rounded-2xl border border-white/9 bg-black/20 p-4">
                  <div className="text-emerald-100">{command}</div>
                  <div className="mt-1 text-xs text-zinc-600">{label}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-[2rem] border border-white/10 bg-[#080d0a]/90 p-6 md:p-7">
            <div className="mb-5 flex items-center justify-between">
              <div>
                <p className="text-xs font-black uppercase tracking-[0.28em] text-lime-200">Protected interface</p>
                <h2 className="mt-2 text-3xl font-black tracking-tight">Operational API</h2>
              </div>
              <div className="rounded-full border border-white/10 px-3 py-1.5 font-mono text-[10px] text-zinc-500">scoped bearer</div>
            </div>
            <div className="space-y-2">
              {interfaces.map(([method, route, description]) => (
                <div key={route} className="grid gap-2 rounded-2xl border border-white/8 bg-white/[0.025] p-4 sm:grid-cols-[64px_1fr]">
                  <div className="font-mono text-xs font-black text-lime-200">{method}</div>
                  <div>
                    <div className="break-all font-mono text-sm text-zinc-100">{route}</div>
                    <div className="mt-1 text-xs leading-5 text-zinc-600">{description}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <footer className="mt-16 flex flex-col gap-3 border-t border-white/8 py-8 text-sm text-zinc-600 sm:flex-row sm:items-center sm:justify-between">
          <div>Zenos Memory · Vercel compute, user-owned Drive, lightweight VPS.</div>
          <div className="font-mono text-xs">public UI contains no private memory</div>
        </footer>
      </section>
    </main>
  );
}
