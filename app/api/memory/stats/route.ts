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
    const namespace = new URL(request.url).searchParams.get('namespace') || undefined;
    const stats = await getMemoryEngine().getStats(namespace);
    return jsonResponse({ success: true, stats, request_id: id }, { requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
