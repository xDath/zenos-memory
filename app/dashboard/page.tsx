export default function Dashboard() {
  const features = [
    'Google Drive OAuth cloud-owned storage',
    'LLM structured handoff via DeepSeek router',
    'Auto compact + bootstrap recovery',
    'Hermes provider auto-trigger',
    'Deterministic vector retrieval + neural-ready embeddings',
    'Temporal graph with Mermaid visualization',
    'Background maintainer + scheduler',
    'Credential-aware secure memory',
    'Persistent lock lease audit',
    'Elite regression benchmark',
  ];

  const endpoints = [
    ['/api/memory/compact', 'LLM structured context compaction'],
    ['/api/memory/bootstrap', 'Recovery bootstrap from compacts + memories'],
    ['/api/memory/vector', 'Advanced vector retrieval'],
    ['/api/memory/graph', 'Temporal graph JSON'],
    ['/api/memory/graph-query', 'Hybrid vector + graph query'],
    ['/api/memory/graph-mermaid', 'Mermaid graph visualization'],
    ['/api/memory/maintain', 'Background memory manager'],
    ['/api/memory/benchmark', 'Elite benchmark'],
    ['/api/memory/scheduler', 'Scheduled maintenance'],
    ['/api/memory/lock', 'Persistent lock lease'],
  ];

  return (
    <main className="min-h-screen bg-[#0b0f0e] text-[#eef8ef] px-6 py-10">
      <section className="mx-auto max-w-6xl">
        <div className="rounded-[2rem] border border-emerald-400/20 bg-gradient-to-br from-emerald-950/70 via-zinc-950 to-lime-950/40 p-8 shadow-2xl shadow-emerald-950/30">
          <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="mb-2 text-sm uppercase tracking-[0.35em] text-emerald-300">Zenos Memory</p>
              <h1 className="text-5xl font-black tracking-tight md:text-7xl">Elite Agent Memory OS</h1>
            </div>
            <div className="rounded-full border border-emerald-300/30 bg-emerald-400/10 px-5 py-3 text-sm text-emerald-100">
              Production Ready
            </div>
          </div>

          <p className="max-w-3xl text-lg leading-8 text-zinc-300">
            Cloud-owned memory layer for Hermes/Zenos: Google Drive OAuth storage, Etla-signed APIs,
            structured LLM compaction, bootstrap recovery, temporal graph, vector retrieval, and secure credential awareness.
          </p>
        </div>

        <div className="mt-8 grid gap-6 md:grid-cols-3">
          <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-6">
            <div className="text-4xl font-black text-emerald-300">13</div>
            <div className="mt-2 text-zinc-300">Implemented roadmap phases</div>
          </div>
          <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-6">
            <div className="text-4xl font-black text-lime-300">Drive</div>
            <div className="mt-2 text-zinc-300">User-owned persistence</div>
          </div>
          <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-6">
            <div className="text-4xl font-black text-cyan-300">Etla</div>
            <div className="mt-2 text-zinc-300">Signed protected runtime</div>
          </div>
        </div>

        <section className="mt-10 grid gap-6 lg:grid-cols-2">
          <div className="rounded-3xl border border-white/10 bg-zinc-950/70 p-6">
            <h2 className="mb-5 text-2xl font-bold">Feature Stack</h2>
            <div className="grid gap-3">
              {features.map((f) => (
                <div key={f} className="rounded-2xl border border-emerald-400/10 bg-emerald-400/[0.03] px-4 py-3 text-zinc-200">
                  {f}
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-3xl border border-white/10 bg-zinc-950/70 p-6">
            <h2 className="mb-5 text-2xl font-bold">Runtime Endpoints</h2>
            <div className="grid gap-3">
              {endpoints.map(([path, desc]) => (
                <div key={path} className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                  <div className="font-mono text-sm text-emerald-300">{path}</div>
                  <div className="mt-1 text-sm text-zinc-400">{desc}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mt-8 rounded-3xl border border-amber-300/20 bg-amber-300/[0.05] p-6 text-amber-100">
          <h2 className="text-2xl font-bold">Security Model</h2>
          <p className="mt-3 text-zinc-300">
            Public dashboard exposes no secrets. Operational APIs require Etla HMAC signatures.
            Credential memories are filtered by default and only returned through explicit credential retrieval paths.
          </p>
        </section>
      </section>
    </main>
  );
}
