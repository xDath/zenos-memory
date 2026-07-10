import { NextRequest } from 'next/server';
import { z } from 'zod';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { errorResponse, requestId } from '../../../lib/errors';
import { enforceRateLimit, jsonResponse } from '../../../lib/http';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { MemorySnapshotSchema } from '../../../lib/schema';

const RestoreSchema = z.object({
  snapshot: MemorySnapshotSchema,
  mode: z.enum(['merge', 'replace']).optional().default('merge'),
  namespace: z.string().optional(),
});

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    enforceRateLimit(request, { bucket: 'restore', limit: 3, windowMs: 60_000 });
    const parsed = RestoreSchema.parse(await request.json());
    const result = await getMemoryEngine().restoreSnapshot(parsed.snapshot, {
      mode: parsed.mode,
      namespace: parsed.namespace,
    });
    return jsonResponse({ success: true, restore: result, request_id: id }, { status: 201, requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
