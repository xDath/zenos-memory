import { NextRequest, NextResponse } from 'next/server';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';
import { CompactRequestSchema } from '../../../lib/compaction';
import { compactWithLLM, hasMemoryLLM } from '../../../lib/memory-llm';
import { getMemoryEngine } from '../../../lib/memory-engine';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();

  try {
    const body = await request.json();
    const req = CompactRequestSchema.parse(body);

    if (!hasMemoryLLM()) {
      return NextResponse.json({ 
        success: false, 
        error: 'LLM enhancer not configured. Set MEMORY_LLM_* envs for advanced compact.' 
      }, { status: 500 });
    }

    // Build full conversation text for LLM
    const conversationText = req.messages
      .map((m: any) => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
      .join('\n\n')
      .slice(0, 24000);

    const llmResult = await compactWithLLM(conversationText);

    if (!llmResult.ok || !llmResult.parsed) {
      return NextResponse.json({ 
        success: false, 
        error: llmResult.error || 'LLM compact failed' 
      }, { status: 500 });
    }

    const parsed = llmResult.parsed;

    // Build advanced structured handoff
    const compactResult = {
      content: llmResult.content,
      type: 'insight' as const,
      metadata: {
        source: 'zenos-memory-advanced-llm-compact',
        confidence: 0.92,
        importance: 10,
        tags: ['advanced-compact', 'structured-handoff', 'llm'],
        provenance: {
          session_id: req.session_id,
          conversation_id: req.conversation_id,
          model: llmResult.model,
          created_by: 'zenos-memory',
          message_count: req.messages.length,
          approx_tokens: req.approx_tokens,
          reason: req.reason,
        },
        blocks: parsed, // full structured blocks
      },
    };

    // Save to Drive
    const engine = getMemoryEngine();
    await engine.remember({
      content: compactResult.content,
      type: 'insight',
      namespace: req.namespace || 'zenos',
      metadata: compactResult.metadata,
    });

    return NextResponse.json({ 
      success: true, 
      compact: compactResult,
      used_llm: true,
      model: llmResult.model,
      structured_blocks: parsed
    });

  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
