import { NextRequest } from 'next/server';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { errorResponse, requestId } from '../../../lib/errors';
import { enforceRateLimit, jsonResponse } from '../../../lib/http';
import { getMemoryEngine } from '../../../lib/memory-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    enforceRateLimit(request, { bucket: 'revision', limit: 300 });
    const body = await request.json().catch(() => ({})) as { namespace?: unknown; force?: unknown };
    const namespace = typeof body.namespace === 'string' && body.namespace.trim()
      ? body.namespace.trim().slice(0, 120)
      : process.env.ZENOS_MEMORY_DEFAULT_NAMESPACE || 'zenos';
    const revision = await getMemoryEngine().revision(namespace, body.force === true);
    return jsonResponse({
      success: true,
      namespace,
      revision,
      request_id: id,
    }, { requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
