import { NextRequest } from 'next/server';
import { z } from 'zod';
import { vectorSearch } from '../../../lib/advanced-memory';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { errorResponse, requestId } from '../../../lib/errors';
import { jsonResponse } from '../../../lib/http';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { MemoryTypeSchema } from '../../../lib/schema';

const VectorSchema = z.object({
  query: z.string().trim().min(1).max(4000),
  namespace: z.string().optional().default('zenos'),
  limit: z.number().int().positive().max(50).optional().default(10),
  type: MemoryTypeSchema.optional(),
});

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    const parsed = VectorSchema.parse(await request.json());
    const memories = await getMemoryEngine().recall({
      query: '',
      namespace: parsed.namespace,
      limit: 5000,
      type: parsed.type,
      include_low_quality: true,
      include_archived: false,
    });
    const results = vectorSearch(parsed.query, memories, parsed.limit).map(result => ({
      id: result.id,
      content: result.text,
      vector_score: Number(result.vector_score.toFixed(6)),
      metadata: result.metadata,
    }));
    return jsonResponse({
      success: true,
      mode: 'deterministic-hashed-vector-baseline',
      query: parsed.query,
      namespace: parsed.namespace,
      count: results.length,
      results,
      request_id: id,
    }, { requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
