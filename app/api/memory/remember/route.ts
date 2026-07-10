import { NextRequest } from 'next/server';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { errorResponse, requestId } from '../../../lib/errors';
import { enforceRateLimit, jsonResponse } from '../../../lib/http';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { RememberRequestSchema } from '../../../lib/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    enforceRateLimit(request, { bucket: 'remember', limit: 90 });
    const parsed = RememberRequestSchema.parse(await request.json());
    const memory = await getMemoryEngine().remember({
      ...parsed,
      idempotency_key: request.headers.get('idempotency-key') || parsed.idempotency_key,
    });
    return jsonResponse({ success: true, memory, request_id: id }, { status: 201, requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
