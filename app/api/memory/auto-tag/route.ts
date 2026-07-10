import { NextRequest } from 'next/server';
import { z } from 'zod';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { errorResponse, requestId } from '../../../lib/errors';
import { jsonResponse } from '../../../lib/http';
import { getMemoryEngine } from '../../../lib/memory-engine';

const AutoTagSchema = z.object({
  id: z.string().uuid(),
  namespace: z.string().optional(),
});

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    const parsed = AutoTagSchema.parse(await request.json());
    const memory = await getMemoryEngine().enhanceMemoryWithAutoTags(parsed.id, parsed.namespace);
    return jsonResponse({ success: Boolean(memory), memory, request_id: id }, { status: memory ? 200 : 404, requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
