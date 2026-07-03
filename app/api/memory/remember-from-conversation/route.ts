import { NextRequest, NextResponse } from 'next/server';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) {
    return unauthorizedResponse();
  }

  try {
    const body = await request.json();
    const { conversation, namespace, conversation_id } = body;

    if (!Array.isArray(conversation) || conversation.length === 0) {
      return NextResponse.json({ error: 'conversation array required' }, { status: 400 });
    }

    const engine = getMemoryEngine();
    const memories = await engine.rememberFromConversation(conversation, namespace || 'default', conversation_id);

    return NextResponse.json({
      success: true,
      count: memories.length,
      memories,
      conversation_id,
    }, { status: 201 });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
