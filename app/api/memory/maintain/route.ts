import { NextRequest } from 'next/server';
import { z } from 'zod';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { errorResponse, requestId } from '../../../lib/errors';
import { jsonResponse } from '../../../lib/http';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { buildMaintenanceReport } from '../../../lib/memory-maintainer';

const MaintainSchema = z.object({
  namespace: z.string().optional().default('zenos'),
  apply_decay: z.boolean().optional().default(false),
  store_report: z.boolean().optional().default(false),
});

async function report(namespace: string) {
  const engine = getMemoryEngine();
  const memories = await engine.recall({
    query: '',
    namespace,
    limit: 5000,
    include_low_quality: true,
    include_archived: true,
  });
  return buildMaintenanceReport(memories);
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    const namespace = new URL(request.url).searchParams.get('namespace') || 'zenos';
    return jsonResponse({ success: true, namespace, report: await report(namespace), applied: false, request_id: id }, { requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    const parsed = MaintainSchema.parse(await request.json().catch(() => ({})));
    const engine = getMemoryEngine();
    const before = await report(parsed.namespace);
    const decayed = parsed.apply_decay ? await engine.applyTemporalDecay(parsed.namespace) : 0;
    const after = parsed.apply_decay ? await report(parsed.namespace) : before;
    if (parsed.store_report) {
      await engine.remember({
        content: JSON.stringify({ generated_at: new Date().toISOString(), before, after, decayed }),
        type: 'insight',
        namespace: parsed.namespace,
        metadata: {
          source: 'zenos-maintainer',
          confidence: 1,
          importance: 4,
          tags: ['maintenance', 'health-report'],
        },
        idempotency_key: request.headers.get('idempotency-key') || undefined,
      });
    }
    return jsonResponse({
      success: true,
      namespace: parsed.namespace,
      applied: parsed.apply_decay,
      decayed,
      report: after,
      request_id: id,
    }, { requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
