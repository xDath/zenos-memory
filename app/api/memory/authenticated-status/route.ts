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
    // The verified materialization is already refreshed by normal traffic and
    // service-start readiness. Probe the local canonical view here without
    // turning every Runtime health check into another synchronous Drive scan.
    const health = await getMemoryEngine().memoryHealthCheck(namespace, { refresh: false });
    return jsonResponse({
      success: true,
      authenticated: true,
      storage_readable: health.storage.ok,
      namespace,
      visible_count_at_least: health.total,
      request_id: id,
    }, { requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
