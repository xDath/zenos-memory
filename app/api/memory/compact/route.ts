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

type FaithfulnessClaim = {
  claim: string;
  section: string;
  evidence_anchor: string | null;
  lexical_support: number;
  supported: boolean;
};

type FaithfulnessReport = {
  valid: boolean;
  score: number;
  claims: number;
  evidence_backed_claims: number;
  unsupported_claims: number;
  packet_integrity: boolean;
  checkpoint_chain_valid: boolean;
  details: FaithfulnessClaim[];
};

const CLAIM_STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'into', 'then', 'than',
  'yang', 'dan', 'untuk', 'dari', 'dengan', 'akan', 'sudah', 'harus', 'atau',
  'current', 'active', 'work', 'continue', 'preserve', 'verify', 'memory', 'zenos',
]);

function claimTokens(value: string): string[] {
  return [...new Set(value
    .toLowerCase()
    .replace(/[^a-z0-9_./:-]+/g, ' ')
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3 && !CLAIM_STOPWORDS.has(item)))]
    .slice(0, 80);
}

function evidenceEntries(text: string): Array<{ anchor: string; text: string; tokens: Set<string> }> {
  const matches = [...text.matchAll(/\[(m\d+:[^\]]+)\]\s*([\s\S]*?)(?=\n\n\[m\d+:|$)/g)];
  return matches.map((match) => {
    const value = String(match[2] || '').replace(/\s+/g, ' ').trim();
    return {
      anchor: String(match[1] || ''),
      text: value,
      tokens: new Set(claimTokens(value)),
    };
  }).filter((item) => item.anchor && item.text);
}

function compactClaims(blocks: Record<string, unknown>): Array<{ section: string; claim: string }> {
  const claims: Array<{ section: string; claim: string }> = [];
  const scalar = (section: string, key: string) => {
    const value = blocks[key];
    if (typeof value === 'string' && value.trim()) claims.push({ section, claim: value.trim() });
  };
  const list = (section: string, key: string) => {
    for (const value of stringList(blocks[key])) claims.push({ section, claim: value });
  };
  scalar('goal', 'current_goal');
  scalar('active_state', 'active_state');
  list('goal', 'goals');
  list('decision', 'key_decisions');
  list('decision', 'decisions');
  list('fact', 'important_facts');
  list('fact', 'facts');
  list('constraint', 'constraints');
  list('validation', 'validations');
  list('completed', 'completed_work');
  list('pending', 'pending_work');
  list('pending', 'tasks');
  list('blocker', 'blockers');
  list('question', 'open_questions');
  list('question', 'questions');
  list('artifact', 'files_artifacts');
  list('artifact', 'artifacts');
  return claims.slice(0, 100);
}

function evaluateFaithfulness(input: {
  blocks: Record<string, unknown>;
  evidenceText: string;
  packetIntegrity: boolean;
  checkpointChainValid: boolean;
}): FaithfulnessReport {
  const entries = evidenceEntries(input.evidenceText);
  const claims = compactClaims(input.blocks);
  const details = claims.map(({ section, claim }): FaithfulnessClaim => {
    const tokens = claimTokens(claim);
    const normalizedClaim = claim.toLowerCase().replace(/\s+/g, ' ').trim();
    let best: { anchor: string; score: number; direct: boolean } | undefined;
    for (const entry of entries) {
      const overlap = tokens.length
        ? tokens.filter((token) => entry.tokens.has(token)).length / tokens.length
        : 0;
      const normalizedEvidence = entry.text.toLowerCase().replace(/\s+/g, ' ').trim();
      const direct = Boolean(normalizedClaim.length >= 12 && (
        normalizedEvidence.includes(normalizedClaim)
        || normalizedClaim.includes(normalizedEvidence.slice(0, Math.min(160, normalizedEvidence.length)))
      ));
      const score = direct ? 1 : overlap;
      if (!best || score > best.score) best = { anchor: entry.anchor, score, direct };
    }
    const threshold = section === 'goal' || section === 'artifact' ? 0.2 : 0.28;
    const supported = Boolean(best && (best.direct || best.score >= threshold));
    return {
      claim: claim.slice(0, 1_200),
      section,
      evidence_anchor: supported ? best?.anchor || null : null,
      lexical_support: Number((best?.score || 0).toFixed(4)),
      supported,
    };
  });
  const evidenceBacked = details.filter((item) => item.supported).length;
  const score = details.length ? evidenceBacked / details.length : 1;
  const goal = details.find((item) => item.section === 'goal');
  const valid = input.packetIntegrity
    && input.checkpointChainValid
    && (!goal || goal.supported)
    && score >= 0.72;
  return {
    valid,
    score: Number(score.toFixed(4)),
    claims: details.length,
    evidence_backed_claims: evidenceBacked,
    unsupported_claims: details.length - evidenceBacked,
    packet_integrity: input.packetIntegrity,
    checkpoint_chain_valid: input.checkpointChainValid,
    details,
  };
}

function faithfulnessGateEnabled(): boolean {
  const value = String(process.env.ZENOS_MEMORY_EVIDENCE_FAITHFULNESS_ENABLED || 'true').trim().toLowerCase();
  return !['0', 'false', 'no', 'off', 'disabled'].includes(value);
}

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
    const llmConfigured = hasMemoryLLM();
    const continuityLlmEnabled = process.env.ZENOS_MEMORY_CONTINUITY_LLM_ENABLED === 'true';
    const shouldUseLlm = llmConfigured && (!parsed.continuity_packet || continuityLlmEnabled);
    let llmTelemetry: LlmTelemetry = {
      configured: llmConfigured,
      succeeded: false,
      fallback_used: false,
      selected_model: null,
      failure_reason: null,
      attempts: [],
    };
    let strategy: 'llm-structured-v2' | 'deterministic-structured-v3' | 'deterministic-dag-v3';

    if (shouldUseLlm) {
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
      llmTelemetry.failure_reason = llmConfigured && parsed.continuity_packet
        ? 'ContinuityPacket v2 uses deterministic compaction by default to stay within the serverless write deadline'
        : 'Memory LLM is not configured';
    }

    if (!content.trim()) throw new Error('Compaction produced no durable content');
    const engine = getMemoryEngine();
    const compactionScope = parsed.session_id
      ? `session:${parsed.session_id}`
      : parsed.conversation_id
        ? `conversation:${parsed.conversation_id}`
        : null;
    const compactHistory = compactionScope
      ? (await engine.list(namespace, 250))
          .filter((item) => {
            const tags = item.metadata.tags || [];
            if (!(tags.includes('compact') || tags.includes('structured-handoff') || tags.includes('dag-compact'))) return false;
            const provenance = item.metadata.provenance;
            return parsed.session_id
              ? provenance?.session_id === parsed.session_id
              : provenance?.conversation_id === parsed.conversation_id;
          })
          .slice(0, 50)
      : [];
    const resolvedPreviousCheckpointId = parsed.previous_checkpoint_id || compactHistory[0]?.id;
    const checkpointChainValid = !parsed.previous_checkpoint_id
      || compactHistory.some((item) => item.id === parsed.previous_checkpoint_id);
    const enforceFaithfulness = faithfulnessGateEnabled();
    let faithfulness = evaluateFaithfulness({
      blocks,
      evidenceText: conversationText,
      packetIntegrity: true,
      checkpointChainValid,
    });

    if (enforceFaithfulness && strategy === 'llm-structured-v2' && !faithfulness.valid) {
      blocks = sanitizeUnknown(deterministic.blocks) as Record<string, unknown>;
      content = deterministic.content;
      coverage = deterministicCoverage(parsed, deterministic);
      strategy = parsed.mode === 'dag' ? 'deterministic-dag-v3' : 'deterministic-structured-v3';
      llmTelemetry = {
        ...llmTelemetry,
        fallback_used: true,
        failure_reason: 'LLM compact rejected by the evidence faithfulness gate',
      };
      faithfulness = evaluateFaithfulness({
        blocks,
        evidenceText: conversationText,
        packetIntegrity: true,
        checkpointChainValid,
      });
    }

    const checkpointValidated = coverage.complete && (!enforceFaithfulness || faithfulness.valid);
    if (parsed.source_cursor) {
      const continuityFooter = [
        '## Continuity Identity',
        `Source cursor: ${parsed.source_cursor}`,
        parsed.continuity_packet?.contentHash
          ? `Packet hash: ${parsed.continuity_packet.contentHash}`
          : '',
        resolvedPreviousCheckpointId
          ? `Previous checkpoint: ${resolvedPreviousCheckpointId}`
          : '',
      ].filter(Boolean).join('\n');
      const contentBudget = parsed.max_chars || 10_000;
      const bodyBudget = Math.max(0, contentBudget - continuityFooter.length - 2);
      content = `${content.slice(0, bodyBudget).trimEnd()}\n\n${continuityFooter}`.slice(0, contentBudget);
    }
    const supersedesIds = checkpointValidated && resolvedPreviousCheckpointId
      ? [resolvedPreviousCheckpointId]
      : [];
    const memory = await engine.remember({
      content,
      type: 'insight',
      namespace,
      metadata: {
        source: 'zenos-memory-compact',
        confidence: checkpointValidated
          ? strategy.startsWith('llm') ? 0.92 : strategy.includes('dag') ? 0.88 : 0.8
          : 0.5,
        importance: 10,
        tags: [
          'compact',
          'structured-handoff',
          strategy,
          coverage.complete ? 'coverage-complete' : 'coverage-partial',
          !enforceFaithfulness
            ? 'faithfulness-gate-disabled'
            : faithfulness.valid
              ? 'faithfulness-complete'
              : 'faithfulness-partial',
          checkpointChainValid ? 'checkpoint-chain-valid' : 'checkpoint-chain-broken',
        ],
        supersedes_ids: supersedesIds,
        provenance: {
          session_id: parsed.session_id,
          conversation_id: parsed.conversation_id,
          source_id: parsed.source_cursor,
          source_hash: parsed.continuity_packet?.contentHash,
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
        source_cursor: parsed.source_cursor,
        previous_checkpoint_id: resolvedPreviousCheckpointId,
        continuity_packet_hash: parsed.continuity_packet?.contentHash,
        checkpoint_validated: checkpointValidated,
        checkpoint_chain_valid: checkpointChainValid,
        faithfulness_gate_enabled: enforceFaithfulness,
        coverage,
        faithfulness,
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
      faithfulness,
      faithfulness_gate_enabled: enforceFaithfulness,
      checkpoint_validated: checkpointValidated,
      source_cursor: parsed.source_cursor,
      previous_checkpoint_id: resolvedPreviousCheckpointId,
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
