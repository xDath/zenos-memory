import { NextRequest } from 'next/server';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { buildCognitiveBrief, CognitiveBriefRequestSchema } from '../../../lib/cognitive-brief';
import { errorResponse, requestId } from '../../../lib/errors';
import { enforceRateLimit, jsonResponse } from '../../../lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    enforceRateLimit(request, { bucket: 'cognitive-brief', limit: 180 });
    const parsed = CognitiveBriefRequestSchema.parse(await request.json());
    const brief = await buildCognitiveBrief(parsed);
    return jsonResponse({
      success: true,
      brief,
      request_id: id,
    }, { requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
