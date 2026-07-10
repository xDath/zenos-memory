import { NextRequest } from 'next/server';
import { z } from 'zod';
import { productionReadiness } from '../../../lib/advanced-memory';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { errorResponse, requestId } from '../../../lib/errors';
import { jsonResponse } from '../../../lib/http';
import { getMemoryEngine } from '../../../lib/memory-engine';

const EvalSchema = z.object({
  namespace: z.string().optional().default('zenos'),
  limit: z.number().int().positive().max(5000).optional().default(1000),
});

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    const parsed = EvalSchema.parse(await request.json().catch(() => ({})));
    const memories = await getMemoryEngine().recall({
      query: '',
      namespace: parsed.namespace,
      limit: parsed.limit,
      include_low_quality: true,
      include_archived: true,
    });
    const readiness = productionReadiness(memories);
    return jsonResponse({
      success: true,
      namespace: parsed.namespace,
      readiness,
      methodology: 'data-quality evaluation over validated, non-secret memory records',
      request_id: id,
    }, { requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
