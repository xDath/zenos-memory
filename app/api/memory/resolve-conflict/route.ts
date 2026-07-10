import { NextRequest } from 'next/server';
import { z } from 'zod';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { errorResponse, requestId } from '../../../lib/errors';
import { jsonResponse } from '../../../lib/http';
import { getMemoryEngine } from '../../../lib/memory-engine';

const ResolveSchema = z.object({
  id1: z.string().uuid(),
  id2: z.string().uuid(),
  namespace: z.string().optional(),
}).refine(value => value.id1 !== value.id2, { message: 'Provide two different memories' });

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    const parsed = ResolveSchema.parse(await request.json());
    const resolution = await getMemoryEngine().resolveConflict(parsed.id1, parsed.id2, parsed.namespace);
    return jsonResponse({ success: true, resolution, request_id: id }, { requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
