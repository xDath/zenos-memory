import { NextRequest } from 'next/server';
import { z } from 'zod';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { errorResponse, requestId } from '../../../lib/errors';
import { jsonResponse } from '../../../lib/http';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { queryGraph } from '../../../lib/memory-maintainer';

const GraphQuerySchema = z.object({
  query: z.string().trim().min(1).max(4000),
  namespace: z.string().optional().default('zenos'),
  limit: z.number().int().positive().max(50).optional().default(10),
});

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    const parsed = GraphQuerySchema.parse(await request.json());
    const memories = await getMemoryEngine().recall({
      query: '',
      namespace: parsed.namespace,
      limit: 5000,
      include_low_quality: true,
      include_archived: true,
    });
    const result = queryGraph(memories, parsed.query, parsed.limit);
    return jsonResponse({ success: true, namespace: parsed.namespace, ...result, request_id: id }, { requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
