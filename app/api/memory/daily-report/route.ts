import { NextRequest } from 'next/server';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { errorResponse, requestId } from '../../../lib/errors';
import { jsonResponse } from '../../../lib/http';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { normalizeNamespace } from '../../../lib/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    const { searchParams } = new URL(request.url);
    const namespace = normalizeNamespace(
      searchParams.get('namespace') || process.env.ZENOS_MEMORY_DEFAULT_NAMESPACE || 'zenos',
    );
    const report = await getMemoryEngine().dailyIntelligenceReport(namespace);
    return jsonResponse({ success: true, namespace, report, request_id: id }, { requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
