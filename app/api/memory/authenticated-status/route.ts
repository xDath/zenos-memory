import { NextRequest } from 'next/server';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { errorResponse, requestId } from '../../../lib/errors';
import { jsonResponse } from '../../../lib/http';
import { getMemoryEngine } from '../../../lib/memory-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    const body = await request.json().catch(() => ({})) as { namespace?: unknown };
    const namespace = typeof body.namespace === 'string' && body.namespace.trim()
      ? body.namespace.trim().slice(0, 120)
      : process.env.ZENOS_MEMORY_DEFAULT_NAMESPACE || 'zenos';
    // A bounded read proves authentication and the canonical storage path are
    // usable without exposing private memory content.
    const memories = await getMemoryEngine().list(namespace, 1);
    return jsonResponse({
      success: true,
      authenticated: true,
      storage_readable: true,
      namespace,
      visible_count_at_least: memories.length,
      request_id: id,
    }, { requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
