import { NextRequest } from 'next/server';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { buildAdvancedCompactSnapshot, CompactRequestSchema, normalizeContent } from '../../../lib/compaction';
import { errorResponse, requestId } from '../../../lib/errors';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { compactWithLLM, hasMemoryLLM } from '../../../lib/memory-llm';
import { redactSensitiveText, sanitizeUnknown } from '../../../lib/secrets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function structuredContent(blocks: Record<string, unknown>): string {
  const sections: string[] = [];
  const scalar = (label: string, key: string) => {
    const value = blocks[key];
    if (typeof value === 'string' && value.trim()) sections.push(`## ${label}\n${value.trim()}`);
  };
  const list = (label: string, key: string) => {
    const value = blocks[key];
    if (Array.isArray(value) && value.length) {
      sections.push(`## ${label}\n${value.map(item => `- ${String(item)}`).join('\n')}`);
    }
  };
  scalar('Current Goal', 'current_goal');
  scalar('Active State', 'active_state');
  list('Key Decisions', 'key_decisions');
  list('Important Facts', 'important_facts');
  list('Completed Work', 'completed_work');
  list('Pending Work', 'pending_work');
  list('Blockers', 'blockers');
  list('Files and Artifacts', 'files_artifacts');
  scalar('Recovery Instructions', 'recovery_instructions');
  return redactSensitiveText(sections.join('\n\n')).slice(0, 64_000);
}

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    const parsed = CompactRequestSchema.parse(await request.json());
    const namespace = parsed.namespace || 'zenos';
    const conversationText = parsed.messages
      .map(message => `${message.role}: ${normalizeContent(message.content)}`)
      .join('\n\n')
      .slice(0, parsed.max_chars || 24_000);

    let content: string;
    let blocks: Record<string, unknown>;
    let model: string | null = null;
    let strategy: 'llm-structured-v1' | 'deterministic-structured-v3';

    if (hasMemoryLLM()) {
      const result = await compactWithLLM(conversationText);
      if (result.ok && result.parsed) {
        blocks = sanitizeUnknown(result.parsed) as Record<string, unknown>;
        content = structuredContent(blocks);
        model = result.model || null;
        strategy = 'llm-structured-v1';
      } else {
        const fallback = buildAdvancedCompactSnapshot(parsed);
        blocks = sanitizeUnknown(fallback.blocks) as Record<string, unknown>;
        content = fallback.content;
        strategy = 'deterministic-structured-v3';
      }
    } else {
      const fallback = buildAdvancedCompactSnapshot(parsed);
      blocks = sanitizeUnknown(fallback.blocks) as Record<string, unknown>;
      content = fallback.content;
      strategy = 'deterministic-structured-v3';
    }

    if (!content.trim()) throw new Error('Compaction produced no durable content');
    const engine = getMemoryEngine();
    const memory = await engine.remember({
      content,
      type: 'insight',
      namespace,
      metadata: {
        source: 'zenos-memory-compact',
        confidence: strategy.startsWith('llm') ? 0.9 : 0.78,
        importance: 10,
        tags: ['compact', 'structured-handoff', strategy],
        provenance: {
          session_id: parsed.session_id,
          conversation_id: parsed.conversation_id,
          created_by: 'zenos-memory',
        },
        message_count: parsed.messages.length,
        approx_tokens: parsed.approx_tokens,
        reason: parsed.reason,
        compact_strategy: strategy,
        blocks,
      },
      idempotency_key: request.headers.get('idempotency-key') || undefined,
    });

    return Response.json({
      success: true,
      compact: memory,
      structured_blocks: blocks,
      strategy,
      model,
      credentials_stored: 0,
      secret_policy: 'raw-secrets-rejected',
      request_id: id,
    }, {
      headers: { 'cache-control': 'no-store', 'x-request-id': id },
    });
  } catch (error) {
    return errorResponse(error, id);
  }
}
