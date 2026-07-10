import { NextRequest } from 'next/server';
import { z } from 'zod';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { errorResponse, requestId } from '../../../lib/errors';
import { enforceRateLimit, jsonResponse } from '../../../lib/http';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { RememberRequestSchema } from '../../../lib/schema';

const BatchSchema = z.object({
  memories: z.array(RememberRequestSchema).min(1).max(250),
});

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    enforceRateLimit(request, { bucket: 'remember-batch', limit: 30 });
    const body = await request.json();
    const parsed = BatchSchema.parse(Array.isArray(body) ? { memories: body } : body);
    const batchKey = request.headers.get('idempotency-key') || undefined;
    const memories = await getMemoryEngine().rememberBatch(parsed.memories.map((memory, index) => ({
      ...memory,
      idempotency_key: memory.idempotency_key || (batchKey ? `${batchKey}:${index}` : undefined),
    })));
    return jsonResponse({ success: true, memories, count: memories.length, request_id: id }, { status: 201, requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
