import { NextRequest } from 'next/server';
import { z } from 'zod';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { errorResponse, requestId } from '../../../lib/errors';
import { enforceRateLimit, jsonResponse } from '../../../lib/http';
import { getMemoryEngine } from '../../../lib/memory-engine';

const TurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(64_000),
});
const ExtractSchema = z.object({
  text: z.string().trim().min(1).max(64_000).optional(),
  content: z.string().trim().min(1).max(64_000).optional(),
  conversation: z.array(TurnSchema).min(1).max(500).optional(),
  namespace: z.string().optional().default('zenos'),
  conversation_id: z.string().max(256).optional(),
}).refine(value => Boolean(value.text || value.content || value.conversation?.length), {
  message: 'text, content, or conversation is required',
});

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    enforceRateLimit(request, { bucket: 'extract', limit: 30 });
    const parsed = ExtractSchema.parse(await request.json());
    const conversation = parsed.conversation || [{ role: 'user' as const, content: parsed.text || parsed.content || '' }];
    const memories = await getMemoryEngine().rememberFromConversation(
      conversation,
      parsed.namespace,
      parsed.conversation_id,
    );
    return jsonResponse({
      success: true,
      namespace: parsed.namespace,
      count: memories.length,
      memories,
      request_id: id,
    }, { status: 201, requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
