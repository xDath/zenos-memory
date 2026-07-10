import { NextRequest } from 'next/server';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { errorResponse, NotFoundError, requestId } from '../../../lib/errors';
import { enforceRateLimit, jsonResponse } from '../../../lib/http';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { ForgetRequestSchema } from '../../../lib/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    enforceRateLimit(request, { bucket: 'forget', limit: 60 });
    const parsed = ForgetRequestSchema.parse(await request.json());
    const removed = await getMemoryEngine().forget(
      parsed.id,
      parsed.namespace,
      parsed.expected_version,
      parsed.hard_delete || false,
    );
    if (!removed) throw new NotFoundError('Memory not found');
    return jsonResponse({ success: true, archived: !parsed.hard_delete, request_id: id }, { requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}

export const POST = DELETE;
