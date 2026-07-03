export default function ZenosMemoryHome() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-200 p-8 font-sans">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 rounded-xl bg-emerald-500 flex items-center justify-center text-black font-bold text-xl">Z</div>
          <div>
            <h1 className="text-4xl font-semibold tracking-tight">Zenos Memory</h1>
            <p className="text-zinc-400">Advanced Custom Memory Layer for Zenos / Hermes</p>
          </div>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-8 mb-8">
          <h2 className="text-xl font-semibold mb-4">Status</h2>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div className="bg-zinc-950 p-4 rounded-xl">
              <div className="text-emerald-400">✅ Phase 0</div>
              <div className="mt-1">Foundation + Core Engine</div>
            </div>
            <div className="bg-zinc-950 p-4 rounded-xl">
              <div>Storage: Google Drive + Local fallback</div>
              <div>API: Next.js on Vercel</div>
            </div>
          </div>
        </div>

        <div className="space-y-8">
          <section>
            <h2 className="text-xl font-semibold mb-3">Core Endpoints</h2>
            <div className="space-y-3">
              {[
                { method: 'POST', path: '/api/memory/remember', desc: 'Store new memory (fact, preference, insight, etc)' },
                { method: 'POST', path: '/api/memory/recall', desc: 'Semantic + keyword recall with filters' },
                { method: 'POST', path: '/api/memory/edit', desc: 'Update existing memory' },
                { method: 'POST', path: '/api/memory/forget', desc: 'Delete memory by ID' },
                { method: 'GET', path: '/api/memory/stats', desc: 'Get memory statistics by namespace' },
              ].map((ep, i) => (
                <div key={i} className="flex gap-4 bg-zinc-900 p-4 rounded-xl font-mono text-sm border border-zinc-800">
                  <span className="text-emerald-400 w-16">{ep.method}</span>
                  <span className="flex-1 text-zinc-300">{ep.path}</span>
                  <span className="text-zinc-500">{ep.desc}</span>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">Usage Example (curl)</h2>
            <pre className="bg-black p-4 rounded-xl overflow-auto text-xs text-emerald-300">
{`# Remember
curl -X POST http://localhost:3090/api/memory/remember \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "content": "Tuan prefers proactive updates and gass langsung style",
    "type": "preference",
    "namespace": "zenos",
    "metadata": { "tags": ["style", "preference"], "confidence": 0.95 }
  }'

# Recall
curl -X POST http://localhost:3090/api/memory/recall \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{ "query": "proactive style", "namespace": "zenos", "limit": 5 }'`}
            </pre>
          </section>

          <section className="text-sm text-zinc-400">
            <p>Auth: Send <code>x-api-key</code> header or <code>Authorization: Bearer ...</code></p>
            <p>Default namespace: <code>default</code>. Use <code>zenos</code> or agent-specific for isolation.</p>
            <p className="mt-2">Roadmap: <a href="https://github.com" className="underline">zenos-memory-roadmap.md</a></p>
          </section>
        </div>
      </div>
    </div>
  );
}
