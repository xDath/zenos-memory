import { NextRequest } from 'next/server';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { errorResponse, requestId } from '../../../lib/errors';
import { jsonResponse, parsePositiveInteger } from '../../../lib/http';
import { getMemoryEngine } from '../../../lib/memory-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    const url = new URL(request.url);
    const namespace = url.searchParams.get('namespace') || undefined;
    const limit = parsePositiveInteger(url.searchParams.get('limit'), 50, 500);
    const memories = await getMemoryEngine().list(namespace, limit);
    return jsonResponse({ success: true, memories, count: memories.length, request_id: id }, { requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
