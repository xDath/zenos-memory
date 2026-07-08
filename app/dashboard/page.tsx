const features = [
  ['Context Lifecycle', 'Auto compact, structured handoff, bootstrap recovery', 'LIVE'],
  ['LLM Memory Agent', 'DeepSeek primary, Gemini fallback, deterministic backup', 'LIVE'],
  ['Cloud-Owned Storage', 'Google Drive OAuth structured persistence', 'LIVE'],
  ['Vector Retrieval', 'Deterministic embeddings + neural-ready endpoint', 'LIVE'],
  ['Temporal Graph', 'Entity, memory, credential and relationship graph', 'LIVE'],
  ['Hybrid Recall', 'Vector + keyword + graph + current-state ranking', 'V2'],
  ['Mutation Engine', 'Supersession, contradiction and timeline planning', 'V3'],
  ['Episodes', 'Temporal/provenance slices across memory events', 'NEW'],
  ['Credential Memory', 'Explicit secret type, filtered recall, secure retrieval', 'LIVE'],
  ['Maintainer', 'Dedup plans, stale checks, graph health, recommendations', 'LIVE'],
  ['Scheduler', 'Daily Vercel cron for background maintenance', 'LIVE'],
  ['Benchmarks', 'Elite regression + real A/B eval suite', 'ELITE PASS'],
  ['A/B Intelligence Eval', '4-case with/without-bootstrap model comparison', 'LIVE'],
];

const endpoints = [
  ['/api/memory/compact', 'POST', 'LLM structured context compaction'],
  ['/api/memory/bootstrap', 'POST', 'Recovery bootstrap from compact + relevant memory'],
  ['/api/memory/vector', 'POST', 'Advanced vector retrieval'],
  ['/api/memory/hybrid-recall', 'POST', 'Hybrid vector + keyword + graph recall'],
  ['/api/memory/mutation-plan', 'POST', 'State-change supersession planning'],
  ['/api/memory/timeline', 'GET', 'Temporal state timeline'],
  ['/api/memory/episodes', 'GET', 'Episode slices with provenance'],
  ['/api/memory/embed', 'POST', 'Neural-ready embedding endpoint + deterministic fallback'],
  ['/api/memory/graph', 'GET', 'Temporal graph JSON'],
  ['/api/memory/graph-query', 'POST', 'Hybrid vector + graph traversal'],
  ['/api/memory/graph-mermaid', 'GET', 'Mermaid graph visualization'],
  ['/api/memory/maintain', 'POST', 'Background memory manager'],
  ['/api/memory/dashboard', 'GET', 'Protected live metrics JSON'],
  ['/api/memory/benchmark', 'POST', 'Elite regression benchmark'],
  ['/api/memory/ab-eval', 'POST', 'Real LLM with/without-bootstrap A/B evaluation'],
  ['/api/memory/scheduler', 'GET/POST', 'Scheduled maintenance'],
  ['/api/memory/lock', 'GET/POST', 'Persistent lock lease audit'],
  ['/api/memory/public-status', 'GET', 'Public safe status'],
];

const timeline = [
  ['01', 'Capture', 'Hermes streams important turns into Zenos Memory.'],
  ['02', 'Extract', 'LLM + deterministic agent extracts facts, tasks, decisions, credentials and entities.'],
  ['03', 'Compact', 'Long context becomes structured handoff instead of plain summary.'],
  ['04', 'Persist', 'Drive OAuth writes structured memory owned by the user.'],
  ['05', 'Recover', 'Bootstrap pulls compact + relevant memories after reset.'],
];

export default function Dashboard() {
  return (
    <main className="min-h-screen overflow-hidden bg-[#070b09] text-[#effaf0]">
      <div className="pointer-events-none fixed inset-0 opacity-70">
        <div className="absolute left-[-10%] top-[-15%] h-[38rem] w-[38rem] rounded-full bg-emerald-500/20 blur-3xl" />
        <div className="absolute right-[-8%] top-[18%] h-[30rem] w-[30rem] rounded-full bg-cyan-400/10 blur-3xl" />
        <div className="absolute bottom-[-20%] left-[25%] h-[34rem] w-[34rem] rounded-full bg-lime-400/10 blur-3xl" />
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.035)_1px,transparent_1px)] bg-[size:48px_48px]" />
      </div>

      <section className="relative mx-auto max-w-7xl px-6 py-10 md:py-14">
        <nav className="mb-12 flex items-center justify-between rounded-full border border-white/10 bg-white/[0.04] px-5 py-3 backdrop-blur-xl">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-full bg-emerald-300 text-lg font-black text-zinc-950">Z</div>
            <div>
              <div className="font-bold">Zenos Memory</div>
              <div className="text-xs text-zinc-400">Cloud-Owned Memory Lab</div>
            </div>
          </div>
          <a href="/api/memory/public-status" className="rounded-full border border-emerald-300/30 px-4 py-2 text-sm text-emerald-200 hover:bg-emerald-300/10">
            JSON Status
          </a>
        </nav>

        <div className="grid gap-8 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
          <div>
            <p className="mb-4 inline-flex rounded-full border border-emerald-300/20 bg-emerald-300/10 px-4 py-2 text-xs font-bold uppercase tracking-[0.32em] text-emerald-200">
              Educational Demo / Cloud-Owned
            </p>
            <h1 className="max-w-4xl text-6xl font-black leading-[0.9] tracking-[-0.06em] md:text-8xl">
              Memory that survives context death.
            </h1>
            <p className="mt-7 max-w-2xl text-lg leading-8 text-zinc-300">
              Zenos Memory is a Drive-owned, Etla-signed educational memory lab for agents: LLM compaction,
              structured handoff, hybrid recall, graph retrieval, credential-aware patterns, scheduler maintenance,
              and bootstrap recovery in one hosted learning deployment.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a href="#evidence" className="rounded-2xl bg-emerald-300 px-5 py-3 font-bold text-zinc-950 hover:bg-emerald-200">
                View Evidence Cards
              </a>
              <a href="/api/memory/public-status" className="rounded-2xl border border-white/15 bg-white/[0.05] px-5 py-3 font-bold text-white hover:bg-white/[0.09]">
                Inspect JSON Status
              </a>
            </div>
          </div>

          <div className="rounded-[2rem] border border-emerald-300/20 bg-zinc-950/75 p-5 shadow-2xl shadow-emerald-950/30 backdrop-blur-xl">
            <div className="mb-4 flex items-center gap-2 border-b border-white/10 pb-4">
              <span className="h-3 w-3 rounded-full bg-red-400" />
              <span className="h-3 w-3 rounded-full bg-amber-300" />
              <span className="h-3 w-3 rounded-full bg-emerald-300" />
              <span className="ml-3 font-mono text-xs text-zinc-400">zenos-memory://command-center</span>
            </div>
            <div className="space-y-3 font-mono text-sm">
              <div><span className="text-zinc-500">storage</span> = <span className="text-emerald-300">Google Drive OAuth</span></div>
              <div><span className="text-zinc-500">auth</span> = <span className="text-emerald-300">Etla HMAC</span></div>
              <div><span className="text-zinc-500">compact</span> = <span className="text-cyan-300">LLM structured handoff</span></div>
              <div><span className="text-zinc-500">retrieval</span> = <span className="text-lime-300">vector + graph + keyword</span></div>
              <div><span className="text-zinc-500">benchmark</span> = <span className="text-emerald-300">elite-pass</span></div>
              <div className="mt-5 rounded-2xl border border-emerald-300/20 bg-emerald-300/[0.06] p-4 text-zinc-200">
                No secrets are exposed here. Protected runtime APIs require Etla signatures; credential memories are filtered by default.
              </div>
            </div>
          </div>
        </div>

        <div className="mt-12 grid gap-4 md:grid-cols-4">
          {[
            ['SDK', 'JS + Python Clients'],
            ['V8', 'Benchmark Evidence'],
            ['Episodes', 'Temporal Slices'],
            ['Hybrid', 'Recall Ranking'],
          ].map(([big, label]) => (
            <div key={label} className="rounded-3xl border border-white/10 bg-white/[0.045] p-6 backdrop-blur-xl">
              <div className="text-4xl font-black text-emerald-200">{big}</div>
              <div className="mt-2 text-sm text-zinc-400">{label}</div>
            </div>
          ))}
        </div>

        <section className="mt-14">
          <div className="mb-5 flex items-end justify-between gap-4">
            <div>
              <p className="text-sm uppercase tracking-[0.25em] text-emerald-300">Feature Matrix</p>
              <h2 className="mt-2 text-4xl font-black tracking-tight">Built for light and heavy memory loads.</h2>
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {features.map(([name, desc, status]) => (
              <div key={name} className="rounded-3xl border border-white/10 bg-zinc-950/70 p-5 transition hover:border-emerald-300/30 hover:bg-emerald-300/[0.04]">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-bold text-white">{name}</h3>
                  <span className="rounded-full bg-emerald-300/10 px-3 py-1 text-[10px] font-black text-emerald-200">{status}</span>
                </div>
                <p className="mt-3 text-sm leading-6 text-zinc-400">{desc}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="evidence" className="mt-14 rounded-[2rem] border border-cyan-300/20 bg-cyan-300/[0.04] p-6">
          <p className="text-sm uppercase tracking-[0.25em] text-cyan-300">Evidence Layer</p>
          <h2 className="mt-2 text-3xl font-black">What is verifiable right now</h2>
          <div className="mt-6 grid gap-3 md:grid-cols-4">
            {[
              ['Smoke Suite', 'public + protected endpoint checks', 'npm run smoke:prod'],
              ['Benchmark V8', 'hybrid + mutation + intelligence amplification evidence', '/api/memory/benchmark'],
              ['A/B Eval V2', 'real model with/without-bootstrap comparison', '/api/memory/ab-eval'],
              ['SDK Imports', 'JS and Python client import checks', 'sdk/js + sdk/python'],
            ].map(([title, desc, link]) => (
              <div key={title} className="rounded-2xl border border-white/10 bg-zinc-950/60 p-4">
                <div className="font-bold text-white">{title}</div>
                <div className="mt-2 text-sm leading-6 text-zinc-400">{desc}</div>
                <div className="mt-3 font-mono text-xs text-cyan-200">{link}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-14 grid gap-6 lg:grid-cols-[0.85fr_1.15fr]">
          <div className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-6">
            <p className="text-sm uppercase tracking-[0.25em] text-cyan-300">Lifecycle</p>
            <h2 className="mt-2 text-3xl font-black">How context becomes durable memory</h2>
            <div className="mt-6 space-y-4">
              {timeline.map(([num, title, desc]) => (
                <div key={num} className="flex gap-4 rounded-2xl border border-white/10 bg-zinc-950/60 p-4">
                  <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-emerald-300 font-black text-zinc-950">{num}</div>
                  <div>
                    <div className="font-bold">{title}</div>
                    <div className="mt-1 text-sm text-zinc-400">{desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div id="endpoints" className="rounded-[2rem] border border-white/10 bg-zinc-950/70 p-6">
            <p className="text-sm uppercase tracking-[0.25em] text-lime-300">API Surface</p>
            <h2 className="mt-2 text-3xl font-black">Protected runtime endpoints</h2>
            <div className="mt-6 grid gap-3">
              {endpoints.map(([path, method, desc]) => (
                <div key={path} className="grid gap-3 rounded-2xl border border-white/10 bg-white/[0.035] p-4 md:grid-cols-[110px_1fr]">
                  <div className="font-mono text-xs font-black text-emerald-300">{method}</div>
                  <div>
                    <div className="font-mono text-sm text-zinc-100">{path}</div>
                    <div className="mt-1 text-sm text-zinc-500">{desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mt-10 rounded-[2rem] border border-amber-300/20 bg-gradient-to-br from-amber-300/[0.08] to-zinc-950 p-7">
          <h2 className="text-3xl font-black">Security Posture</h2>
          <p className="mt-3 max-w-4xl leading-7 text-zinc-300">
            Public UI is informational only. Memory, credentials, graph internals, compaction output, and dashboard metrics
            remain behind Etla HMAC signed APIs. Credentials are first-class memory objects, filtered from normal recall,
            and retrievable only through explicit credential paths.
          </p>
        </section>
      </section>
    </main>
  );
}
