import { NextRequest } from 'next/server';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { errorResponse, NotFoundError, requestId } from '../../../lib/errors';
import { enforceRateLimit, jsonResponse } from '../../../lib/http';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { EditRequestSchema } from '../../../lib/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    enforceRateLimit(request, { bucket: 'edit', limit: 90 });
    const parsed = EditRequestSchema.parse(await request.json());
    const memory = await getMemoryEngine().edit(parsed.id, {
      content: parsed.content,
      namespace: parsed.namespace,
      metadata: parsed.metadata,
    }, parsed.namespace, parsed.expected_version);
    if (!memory) throw new NotFoundError('Memory not found');
    return jsonResponse({ success: true, memory, request_id: id }, { requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}

export const POST = PATCH;
