import { NextRequest } from 'next/server';
import { z } from 'zod';
import { unauthorizedResponse, validateApiKey } from '../../../../lib/auth';
import { errorResponse, requestId } from '../../../../lib/errors';
import { jsonResponse } from '../../../../lib/http';
import { answerWithMemoryLLM, hasMemoryLLM } from '../../../../lib/memory-llm';

const TestSchema = z.object({ prompt: z.string().max(2000).optional() });

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    if (!hasMemoryLLM()) {
      return jsonResponse({ success: false, configured: false, request_id: id }, { status: 503, requestId: id });
    }
    const parsed = TestSchema.parse(await request.json().catch(() => ({})));
    const result = await answerWithMemoryLLM(parsed.prompt || 'Reply with a short confirmation that the memory worker is reachable.');
    return jsonResponse({
      success: result.ok,
      configured: true,
      model: result.model,
      latency_ms: result.latency_ms,
      output_valid: Boolean(result.parsed?.answer),
      error: result.error,
      request_id: id,
    }, { status: result.ok ? 200 : 503, requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
