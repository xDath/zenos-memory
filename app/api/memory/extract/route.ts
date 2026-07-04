import { NextRequest, NextResponse } from 'next/server';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();

  try {
    const body = await request.json();
    const namespace = body.namespace || 'zenos';
    const conversation = Array.isArray(body.conversation)
      ? body.conversation
      : [{ role: 'user', content: String(body.text || body.content || '') }];

    if (!conversation.some((t: any) => t.content)) {
      return NextResponse.json({ error: 'text/content or conversation is required' }, { status: 400 });
    }

    const engine = getMemoryEngine();
    const memories = await engine.rememberFromConversation(conversation, namespace, body.conversation_id);

    return NextResponse.json({
      success: true,
      namespace,
      count: memories.length,
      memories,
    }, { status: 201 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
