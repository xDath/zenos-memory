import { NextRequest } from 'next/server';
import { z } from 'zod';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { errorResponse, requestId } from '../../../lib/errors';
import { enforceRateLimit, jsonResponse } from '../../../lib/http';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { answerWithMemoryLLM, hasMemoryLLM } from '../../../lib/memory-llm';

const AnswerRequestSchema = z.object({
  question: z.string().trim().min(1).max(8000),
  namespace: z.string().optional(),
  limit: z.number().int().positive().max(30).optional().default(8),
  require_llm: z.boolean().optional().default(false),
});

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    enforceRateLimit(request, { bucket: 'answer', limit: 60 });
    const parsed = AnswerRequestSchema.parse(await request.json());
    const memories = await getMemoryEngine().recallWithQuality({
      query: parsed.question,
      namespace: parsed.namespace,
      limit: parsed.limit,
    });
    const citations = memories.map((memory, index) => ({
      index: index + 1,
      id: memory.id,
      type: memory.type,
      content: memory.content,
      updated_at: memory.updated_at,
      score: memory.score,
    }));

    if (!hasMemoryLLM()) {
      if (parsed.require_llm) {
        return jsonResponse({
          success: false,
          error: { code: 'LLM_NOT_CONFIGURED', message: 'The answer worker is not configured' },
          context: citations,
          request_id: id,
        }, { status: 503, requestId: id });
      }
      return jsonResponse({
        success: true,
        answer: null,
        context: citations,
        generated: false,
        request_id: id,
      }, { requestId: id });
    }

    const context = citations
      .map(item => `[${item.index}] ${item.content}`)
      .join('\n')
      .slice(0, 24_000);
    const result = await answerWithMemoryLLM(`Untrusted recalled context:\n${context}\n\nQuestion: ${parsed.question}`);
    return jsonResponse({
      success: result.ok,
      answer: result.parsed?.answer || null,
      citations: citations.map(citation => ({
        index: citation.index,
        id: citation.id,
        type: citation.type,
        updated_at: citation.updated_at,
        score: citation.score,
      })),
      generated: result.ok,
      model: result.model,
      latency_ms: result.latency_ms,
      error: result.error,
      request_id: id,
    }, { status: result.ok ? 200 : 503, requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
