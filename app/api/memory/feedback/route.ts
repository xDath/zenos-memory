import { NextRequest } from 'next/server';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { errorResponse, requestId } from '../../../lib/errors';
import { enforceRateLimit, jsonResponse } from '../../../lib/http';
import { readJsonBodyBounded } from '../../../lib/http-body';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { RecallFeedbackRequestSchema } from '../../../lib/recall-feedback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    enforceRateLimit(request, { bucket: 'recall-feedback', limit: 180 });
    const parsed = RecallFeedbackRequestSchema.parse(await readJsonBodyBounded(request, 96_000));
    const result = await getMemoryEngine().recordRecallFeedback({
      ...parsed,
      feedback_id: request.headers.get('idempotency-key') || parsed.feedback_id,
    });
    return jsonResponse({ success: true, feedback: result, request_id: id }, {
      status: result.deduplicated ? 200 : 201,
      requestId: id,
    });
  } catch (error) {
    return errorResponse(error, id);
  }
}
