import { NextRequest } from 'next/server';
import { z } from 'zod';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { errorResponse, requestId } from '../../../lib/errors';
import { jsonResponse } from '../../../lib/http';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { MemorySchema, MemoryTypeSchema } from '../../../lib/schema';

const ConflictSchema = z.object({
  content: z.string().trim().min(1).max(64_000),
  type: MemoryTypeSchema.optional().default('fact'),
  namespace: z.string().optional().default('zenos'),
});

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    const parsed = ConflictSchema.parse(await request.json());
    const now = new Date().toISOString();
    const candidate = MemorySchema.parse({
      id: '00000000-0000-4000-8000-000000000000',
      content: parsed.content,
      type: parsed.type,
      namespace: parsed.namespace,
      metadata: {},
      created_at: now,
      updated_at: now,
    });
    const conflicts = await getMemoryEngine().detectConflicts(candidate, parsed.namespace);
    return jsonResponse({ success: true, conflicts, count: conflicts.length, request_id: id }, { requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
