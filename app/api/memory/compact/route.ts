import { NextRequest } from 'next/server';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import {
  buildAdvancedCompactSnapshot,
  buildCompactionEvidencePacket,
  buildDagCompactSnapshot,
  CompactRequest,
  CompactRequestSchema,
  selectDurableUserGoal,
} from '../../../lib/compaction';
import { errorResponse, requestId } from '../../../lib/errors';
import { readJsonBodyBounded } from '../../../lib/http-body';
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

type LlmTelemetry = {
  configured: boolean;
  succeeded: boolean;
  fallback_used: boolean;
  selected_model: string | null;
  failure_reason: string | null;
  attempts: Array<{ model: string; ok: boolean; error?: string; latency_ms?: number }>;
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

function lastUserGoal(messages: CompactRequest['messages']): string {
  return selectDurableUserGoal(messages);
}

function mergeCoverage(
  rawBlocks: Record<string, unknown>,
  fallback: ReturnType<typeof buildAdvancedCompactSnapshot>,
  messages: CompactRequest['messages'],
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

function deterministicCoverage(
  parsed: CompactRequest,
  deterministic: ReturnType<typeof buildAdvancedCompactSnapshot>,
): CoverageReport {
  const source = buildAdvancedCompactSnapshot(parsed);
  const candidate = deterministic.blocks;
  const covered = (expected: unknown[] | undefined, actual: unknown[] | undefined) =>
    (expected || []).length === 0 || (actual || []).length > 0;
  const coverage: CoverageReport = {
    goal: Boolean(lastUserGoal(parsed.messages)),
    decisions: covered(source.blocks.decisions, candidate.decisions),
    pendingWork: covered(source.blocks.tasks, candidate.tasks),
    questions: covered(source.blocks.questions, candidate.questions),
    artifacts: covered(source.blocks.artifacts, candidate.artifacts),
    complete: false,
  };
  coverage.complete = coverage.goal
    && coverage.decisions
    && coverage.pendingWork
    && coverage.questions
    && coverage.artifacts;
  return coverage;
}

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    const parsed = CompactRequestSchema.parse(await readJsonBodyBounded(request, 768_000));
    const namespace = parsed.namespace || 'zenos';
    const deterministic = parsed.mode === 'dag'
      ? buildDagCompactSnapshot(parsed)
      : buildAdvancedCompactSnapshot(parsed);
    const evidencePacket = buildCompactionEvidencePacket(
      parsed.messages,
      Math.min(parsed.input_max_chars || 120_000, 60_000),
    );
    const conversationText = evidencePacket.text;

    let content: string;
    let blocks: Record<string, unknown>;
    let coverage: CoverageReport;
    let model: string | null = null;
    let llmUsage: Record<string, number> | null = null;
    let llmTelemetry: LlmTelemetry = {
      configured: hasMemoryLLM(),
      succeeded: false,
      fallback_used: false,
      selected_model: null,
      failure_reason: null,
      attempts: [],
    };
    let strategy: 'llm-structured-v2' | 'deterministic-structured-v3' | 'deterministic-dag-v3';

    if (hasMemoryLLM()) {
      // The deterministic snapshot remains the fallback/coverage source; do not
      // duplicate it inside the LLM prompt alongside the same raw transcript.
      const result = await compactWithLLM(conversationText);
      llmTelemetry = {
        configured: true,
        succeeded: result.ok,
        fallback_used: Boolean(result.fallback_used),
        selected_model: result.ok ? result.model || null : null,
        failure_reason: result.ok ? null : result.error || 'Memory LLM compaction failed',
        attempts: result.attempts || [],
      };
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
        llmUsage = {
          input_tokens: result.input_tokens || 0,
          output_tokens: result.output_tokens || 0,
          reasoning_tokens: result.reasoning_tokens || 0,
          cache_read_tokens: result.cache_read_tokens || 0,
          total_tokens: result.total_tokens || 0,
        };
        strategy = 'llm-structured-v2';
      } else {
        blocks = sanitizeUnknown(deterministic.blocks) as Record<string, unknown>;
        content = deterministic.content;
        strategy = parsed.mode === 'dag' ? 'deterministic-dag-v3' : 'deterministic-structured-v3';
        coverage = deterministicCoverage(parsed, deterministic);
      }
    } else {
      blocks = sanitizeUnknown(deterministic.blocks) as Record<string, unknown>;
      content = deterministic.content;
      strategy = parsed.mode === 'dag' ? 'deterministic-dag-v3' : 'deterministic-structured-v3';
      coverage = deterministicCoverage(parsed, deterministic);
      llmTelemetry.failure_reason = 'Memory LLM is not configured';
    }

    if (!content.trim()) throw new Error('Compaction produced no durable content');
    const engine = getMemoryEngine();
    const compactionScope = parsed.session_id
      ? `session:${parsed.session_id}`
      : parsed.conversation_id
        ? `conversation:${parsed.conversation_id}`
        : null;
    const previousCompacts = compactionScope
      ? (await engine.list(namespace, 250))
          .filter((item) => {
            const tags = item.metadata.tags || [];
            if (!(tags.includes('compact') || tags.includes('structured-handoff') || tags.includes('dag-compact'))) return false;
            const provenance = item.metadata.provenance;
            return parsed.session_id
              ? provenance?.session_id === parsed.session_id
              : provenance?.conversation_id === parsed.conversation_id;
          })
          .slice(0, 20)
          .map((item) => item.id)
      : [];
    const memory = await engine.remember({
      content,
      type: 'insight',
      namespace,
      metadata: {
        source: 'zenos-memory-compact',
        confidence: strategy.startsWith('llm') ? 0.92 : strategy.includes('dag') ? 0.88 : 0.8,
        importance: 10,
        tags: ['compact', 'structured-handoff', strategy, coverage.complete ? 'coverage-complete' : 'coverage-partial'],
        supersedes_ids: previousCompacts,
        provenance: {
          session_id: parsed.session_id,
          conversation_id: parsed.conversation_id,
          created_by: 'zenos-memory',
        },
        message_count: parsed.messages.length,
        approx_tokens: parsed.approx_tokens,
        input_chars: conversationText.length,
        source_input_chars: evidencePacket.sourceChars,
        output_chars: content.length,
        source_coverage: {
          source_messages: evidencePacket.sourceMessages,
          selected_messages: evidencePacket.selectedMessages,
          omitted_messages: evidencePacket.omittedMessages,
          selected_chars: evidencePacket.selectedChars,
          category_counts: evidencePacket.categoryCounts,
          selected_category_counts: evidencePacket.selectedCategoryCounts,
          category_coverage: evidencePacket.categoryCoverage,
          evidence_anchors: evidencePacket.anchors,
        },
        reason: parsed.reason,
        compaction_scope: compactionScope,
        compact_strategy: strategy,
        coverage,
        block_counts: {
          decisions: stringList(blocks.key_decisions).length,
          facts: stringList(blocks.important_facts).length,
          completed: stringList(blocks.completed_work).length,
          pending: stringList(blocks.pending_work).length,
          blockers: stringList(blocks.blockers).length,
          questions: stringList(blocks.open_questions).length,
          artifacts: stringList(blocks.files_artifacts).length,
        },
        llm_usage: llmUsage,
        llm_telemetry: llmTelemetry,
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
      llm_usage: llmUsage,
      llm_telemetry: llmTelemetry,
      source_coverage: {
        source_messages: evidencePacket.sourceMessages,
        selected_messages: evidencePacket.selectedMessages,
        omitted_messages: evidencePacket.omittedMessages,
        source_chars: evidencePacket.sourceChars,
        selected_chars: evidencePacket.selectedChars,
        category_coverage: evidencePacket.categoryCoverage,
      },
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
