import { NextRequest } from 'next/server';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { errorResponse, requestId } from '../../../lib/errors';
import { enforceRateLimit, jsonResponse } from '../../../lib/http';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { RecallRequestSchema } from '../../../lib/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    enforceRateLimit(request, { bucket: 'recall', limit: 180 });
    const parsed = RecallRequestSchema.parse(await request.json());
    const memories = await getMemoryEngine().recall(parsed);
    return jsonResponse({ success: true, memories, count: memories.length, request_id: id }, { requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
