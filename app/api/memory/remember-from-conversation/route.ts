import { NextRequest } from 'next/server';
import { z } from 'zod';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { errorResponse, requestId } from '../../../lib/errors';
import { enforceRateLimit, jsonResponse } from '../../../lib/http';
import { getMemoryEngine } from '../../../lib/memory-engine';

const ConversationSchema = z.object({
  conversation: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1).max(64_000),
  })).min(1).max(500),
  namespace: z.string().optional(),
  conversation_id: z.string().max(256).optional(),
});

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    enforceRateLimit(request, { bucket: 'conversation-ingest', limit: 30 });
    const parsed = ConversationSchema.parse(await request.json());
    const memories = await getMemoryEngine().rememberFromConversation(
      parsed.conversation,
      parsed.namespace,
      parsed.conversation_id,
    );
    return jsonResponse({ success: true, memories, count: memories.length, request_id: id }, { status: 201, requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
