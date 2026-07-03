import { headers } from "next/headers";
import * as crypto from "crypto";

function accessDenied(message: string) {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-200 flex items-center justify-center p-8">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-red-500">Access Denied</h1>
        <p className="mt-2 text-zinc-400">{message}</p>
        <p className="mt-4 text-sm">Zenos Memory - Internal Use Only</p>
      </div>
    </div>
  );
}

export default async function ZenosMemoryHome() {
  const headersList = headers();
  const etlaSecret = process.env.ETLA_MASTER_SECRET;

  if (etlaSecret) {
    const ts = headersList.get("x-etla-timestamp") || "";
    const sig = headersList.get("x-etla-signature") || "";

    if (!ts || !sig) {
      return accessDenied("Etla signature required (x-etla-timestamp + x-etla-signature)");
    }

    const now = Date.now();
    const timestamp = parseInt(ts, 10);
    if (isNaN(timestamp) || Math.abs(now - timestamp) > 5 * 60 * 1000) {
      return accessDenied("Signature expired (max 5 min window)");
    }

    const method = "GET";
    const path = "/";

    const payload = `${timestamp}:${method}:${path}`;
    const expected = crypto
      .createHmac("sha256", etlaSecret)
      .update(payload, "utf8")
      .digest("hex");

    if (sig !== expected) {
      return accessDenied("Invalid Etla signature");
    }
  } else {
    const apiKey = headersList.get("x-api-key") || "";
    const validKey = process.env.ZENOS_MEMORY_API_KEY || "";
    if (apiKey !== validKey) {
      return accessDenied("Valid x-api-key required");
    }
  }

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
