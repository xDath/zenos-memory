import { NextRequest } from 'next/server';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import {
  buildAdvancedCompactSnapshot,
  buildDagCompactSnapshot,
  CompactRequestSchema,
  normalizeContent,
} from '../../../lib/compaction';
import { errorResponse, requestId } from '../../../lib/errors';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { compactWithLLM, hasMemoryLLM } from '../../../lib/memory-llm';
import { redactSensitiveText, sanitizeUnknown } from '../../../lib/secrets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type CoverageReport = {
  goal: boolean;
  decisions: boolean;
  pendingWork: boolean;
  questions: boolean;
  artifacts: boolean;
  complete: boolean;
};

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function mergeLists(primary: unknown, fallback: string[] | undefined, max = 18): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const item of [...stringList(primary), ...(fallback || [])]) {
    const clean = redactSensitiveText(item).replace(/\s+/g, ' ').trim();
    const key = clean.toLowerCase().slice(0, 240);
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    merged.push(clean.slice(0, 1_200));
    if (merged.length >= max) break;
  }
  return merged;
}

function lastUserGoal(messages: Array<{ role: string; content?: unknown }>): string {
  for (const message of [...messages].reverse()) {
    if (String(message.role).toLowerCase() !== 'user') continue;
    const text = normalizeContent(message.content).replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, 2_000);
  }
  return '';
}

function boundedConversationText(
  messages: Array<{ role: string; content?: unknown }>,
  maxChars: number,
): string {
  const rendered = messages
    .map((message) => `${message.role}: ${normalizeContent(message.content)}`)
    .join('\n\n');
  if (rendered.length <= maxChars) return rendered;
  const headChars = Math.max(4_000, Math.floor(maxChars * 0.18));
  const marker = '\n\n[OLDER LOW-SIGNAL CONTEXT OMITTED; RECENT CONTEXT FOLLOWS]\n\n';
  const tailChars = Math.max(8_000, maxChars - headChars - marker.length);
  return `${rendered.slice(0, headChars).trimEnd()}${marker}${rendered.slice(-tailChars).trimStart()}`;
}

function mergeCoverage(
  rawBlocks: Record<string, unknown>,
  fallback: ReturnType<typeof buildAdvancedCompactSnapshot>,
  messages: Array<{ role: string; content?: unknown }>,
): { blocks: Record<string, unknown>; coverage: CoverageReport } {
  const blocks: Record<string, unknown> = {
    ...rawBlocks,
    current_goal: typeof rawBlocks.current_goal === 'string' && rawBlocks.current_goal.trim()
      ? rawBlocks.current_goal.trim()
      : lastUserGoal(messages),
    key_decisions: mergeLists(rawBlocks.key_decisions, fallback.blocks.decisions),
    important_facts: mergeLists(rawBlocks.important_facts, fallback.blocks.facts),
    pending_work: mergeLists(rawBlocks.pending_work, fallback.blocks.tasks),
    open_questions: mergeLists(rawBlocks.open_questions, fallback.blocks.questions),
    files_artifacts: mergeLists(rawBlocks.files_artifacts, fallback.blocks.artifacts),
  };

  if (!(typeof blocks.active_state === 'string' && blocks.active_state.trim())) {
    blocks.active_state = (fallback.blocks.timeline || []).slice(-5).join(' | ').slice(0, 3_000);
  }
  if (!(typeof blocks.recovery_instructions === 'string' && blocks.recovery_instructions.trim())) {
    blocks.recovery_instructions = 'Continue from the current goal, preserve recorded constraints, verify unresolved work, and retrieve archived evidence only when needed.';
  }

  const coverage: CoverageReport = {
    goal: Boolean(String(blocks.current_goal || '').trim()),
    decisions: fallback.blocks.decisions.length === 0 || stringList(blocks.key_decisions).length > 0,
    pendingWork: fallback.blocks.tasks.length === 0 || stringList(blocks.pending_work).length > 0,
    questions: fallback.blocks.questions.length === 0 || stringList(blocks.open_questions).length > 0,
    artifacts: (fallback.blocks.artifacts || []).length === 0 || stringList(blocks.files_artifacts).length > 0,
    complete: false,
  };
  coverage.complete = coverage.goal
    && coverage.decisions
    && coverage.pendingWork
    && coverage.questions
    && coverage.artifacts;
  return { blocks, coverage };
}

function structuredContent(blocks: Record<string, unknown>, maxChars: number): string {
  const sections: string[] = [];
  const scalar = (label: string, key: string) => {
    const value = blocks[key];
    if (typeof value === 'string' && value.trim()) sections.push(`## ${label}\n${value.trim()}`);
  };
  const list = (label: string, key: string) => {
    const value = stringList(blocks[key]);
    if (value.length) sections.push(`## ${label}\n${value.map((item) => `- ${item}`).join('\n')}`);
  };
  const record = (label: string, key: string) => {
    const value = blocks[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const rows = Object.entries(value)
      .map(([name, item]) => `- ${name}: ${String(item)}`)
      .slice(0, 20);
    if (rows.length) sections.push(`## ${label}\n${rows.join('\n')}`);
  };

  scalar('Current Goal', 'current_goal');
  scalar('Active State', 'active_state');
  list('Key Decisions', 'key_decisions');
  record('User Preferences', 'user_preferences');
  list('Important Facts', 'important_facts');
  list('Completed Work', 'completed_work');
  list('Pending Work', 'pending_work');
  list('Blockers', 'blockers');
  list('Open Questions', 'open_questions');
  list('Files and Artifacts', 'files_artifacts');
  scalar('Recovery Instructions', 'recovery_instructions');
  return redactSensitiveText(sections.join('\n\n')).slice(0, maxChars);
}

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    const parsed = CompactRequestSchema.parse(await request.json());
    const namespace = parsed.namespace || 'zenos';
    const deterministic = parsed.mode === 'dag'
      ? buildDagCompactSnapshot(parsed)
      : buildAdvancedCompactSnapshot(parsed);
    const conversationText = boundedConversationText(parsed.messages, parsed.input_max_chars || 120_000);

    let content: string;
    let blocks: Record<string, unknown>;
    let coverage: CoverageReport;
    let model: string | null = null;
    let strategy: 'llm-structured-v2' | 'deterministic-structured-v3' | 'deterministic-dag-v3';

    if (hasMemoryLLM()) {
      const result = await compactWithLLM(`${deterministic.content}\n\n## Bounded Source Transcript\n${conversationText}`);
      if (result.ok && result.parsed) {
        const merged = mergeCoverage(
          sanitizeUnknown(result.parsed) as Record<string, unknown>,
          buildAdvancedCompactSnapshot(parsed),
          parsed.messages,
        );
        blocks = merged.blocks;
        coverage = merged.coverage;
        content = structuredContent(blocks, parsed.max_chars || 10_000);
        model = result.model || null;
        strategy = 'llm-structured-v2';
      } else {
        blocks = sanitizeUnknown(deterministic.blocks) as Record<string, unknown>;
        content = deterministic.content;
        strategy = parsed.mode === 'dag' ? 'deterministic-dag-v3' : 'deterministic-structured-v3';
        coverage = {
          goal: Boolean(lastUserGoal(parsed.messages)),
          decisions: true,
          pendingWork: true,
          questions: true,
          artifacts: true,
          complete: Boolean(lastUserGoal(parsed.messages)),
        };
      }
    } else {
      blocks = sanitizeUnknown(deterministic.blocks) as Record<string, unknown>;
      content = deterministic.content;
      strategy = parsed.mode === 'dag' ? 'deterministic-dag-v3' : 'deterministic-structured-v3';
      coverage = {
        goal: Boolean(lastUserGoal(parsed.messages)),
        decisions: true,
        pendingWork: true,
        questions: true,
        artifacts: true,
        complete: Boolean(lastUserGoal(parsed.messages)),
      };
    }

    if (!content.trim()) throw new Error('Compaction produced no durable content');
    const engine = getMemoryEngine();
    const memory = await engine.remember({
      content,
      type: 'insight',
      namespace,
      metadata: {
        source: 'zenos-memory-compact',
        confidence: strategy.startsWith('llm') ? 0.92 : strategy.includes('dag') ? 0.88 : 0.8,
        importance: 10,
        tags: ['compact', 'structured-handoff', strategy, coverage.complete ? 'coverage-complete' : 'coverage-partial'],
        provenance: {
          session_id: parsed.session_id,
          conversation_id: parsed.conversation_id,
          created_by: 'zenos-memory',
        },
        message_count: parsed.messages.length,
        approx_tokens: parsed.approx_tokens,
        input_chars: conversationText.length,
        output_chars: content.length,
        reason: parsed.reason,
        compact_strategy: strategy,
        coverage,
        blocks,
      },
      idempotency_key: request.headers.get('idempotency-key') || undefined,
    });

    return Response.json({
      success: true,
      compact: memory,
      structured_blocks: blocks,
      coverage,
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
