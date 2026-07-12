import { NextRequest } from 'next/server';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { errorResponse, requestId } from '../../../lib/errors';
import { enforceRateLimit, jsonResponse } from '../../../lib/http';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { RecallRequestSchema } from '../../../lib/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    enforceRateLimit(request, { bucket: 'hybrid-recall', limit: 180 });
    const parsed = RecallRequestSchema.parse(await request.json());
    const results = await getMemoryEngine().recallWithQuality(parsed);
    return jsonResponse({
      success: true,
      results,
      count: results.length,
      retrieval: 'dense-sparse-graph-rrf-lifecycle-v2',
      request_id: id,
    }, { requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
