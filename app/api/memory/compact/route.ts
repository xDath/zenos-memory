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
    const engine = getMemoryEngine();
    const namespace = req.namespace || 'zenos';

    // Store the main structured handoff as insight
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
        blocks: parsed,
      },
    };

    await engine.remember({
      content: compactResult.content,
      type: 'insight',
      namespace,
      metadata: compactResult.metadata,
    });

    // Automatically store any extracted credentials as separate 'credential' memories
    if (parsed.credentials && Array.isArray(parsed.credentials)) {
      for (const cred of parsed.credentials) {
        if (cred.service && cred.key) {
          await engine.remember({
            content: cred.key,
            type: 'credential',
            namespace,
            metadata: {
              credential_for: cred.service,
              description: cred.description || '',
              is_secret: true,
              source: 'llm-extracted-from-compact',
              importance: 9,
              confidence: 0.95,
            },
          });
        }
      }
    }

    return NextResponse.json({ 
      success: true, 
      compact: compactResult,
      used_llm: true,
      model: llmResult.model,
      structured_blocks: parsed,
      credentials_stored: parsed.credentials ? parsed.credentials.length : 0
    });

  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
