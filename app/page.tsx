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
              <div className="text-emerald-400">✅ All Phases Complete</div>
              <div className="mt-1">0 to 5 - Fully Implemented & Tested</div>
            </div>
            <div className="bg-zinc-950 p-4 rounded-xl">
              <div>Storage: Google Drive (secure)</div>
              <div>Auth: Etla Signature (master secret)</div>
            </div>
          </div>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-8">
          <h2 className="text-xl font-semibold mb-4">Protected Service</h2>
          <p>This is an internal service for Zenos/Hermes agent.</p>
          <p className="mt-2 text-sm text-zinc-400">Only Etla (with the master secret) can access using signed requests.</p>
          <p className="mt-4 text-xs">Deployed securely. Source: private GitHub.</p>
        </div>
      </div>
    </div>
  );
}
