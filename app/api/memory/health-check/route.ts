import { NextRequest } from 'next/server';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { errorResponse, requestId } from '../../../lib/errors';
import { jsonResponse } from '../../../lib/http';
import { getMemoryEngine } from '../../../lib/memory-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    const namespace = new URL(request.url).searchParams.get('namespace') || 'zenos';
    const engine = getMemoryEngine();
    const [readiness, memoryHealth] = await Promise.all([
      engine.readiness(namespace),
      engine.memoryHealthCheck(namespace),
    ]);
    const ready = readiness.ready && readiness.backup.healthy && readiness.security.fail_closed;
    return jsonResponse({
      success: ready,
      ready,
      readiness,
      memory_health: memoryHealth,
      request_id: id,
    }, { status: ready ? 200 : 503, requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
