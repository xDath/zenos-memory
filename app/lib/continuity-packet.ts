import { createHash } from 'node:crypto';
import { z } from 'zod';

export const ContinuityMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'tool', 'system']),
  content: z.string().max(32_000),
  name: z.string().trim().max(200).optional(),
  tool_call_id: z.string().trim().max(500).optional(),
  message_id: z.string().trim().max(500).optional(),
});

const ContextMilestoneSchema = z.object({
  kind: z.enum(['goal', 'decision', 'constraint', 'tool_result', 'patch', 'validation', 'blocker']),
  text: z.string().trim().min(1).max(8_000),
  sourceMessageIds: z.array(z.string().trim().min(1).max(500)).max(32).default([]),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  occurredAt: z.string().datetime(),
});

const ContinuityToolStateSchema = z.object({
  id: z.string().trim().min(1).max(500),
  tool: z.string().trim().min(1).max(200),
  status: z.enum(['queued', 'running', 'passed', 'failed', 'blocked', 'unknown']),
  summary: z.string().trim().max(8_000).default(''),
  changedFiles: z.array(z.string().trim().min(1).max(4_096)).max(200).default([]),
  artifactIds: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  sourceMessageIds: z.array(z.string().trim().min(1).max(500)).max(32).default([]),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  occurredAt: z.string().datetime(),
});

const ContinuityOpenWorkSchema = z.object({
  id: z.string().trim().min(1).max(500),
  kind: z.enum(['inspect', 'plan', 'patch', 'validate', 'verify', 'deliver', 'approval', 'other']),
  text: z.string().trim().min(1).max(8_000),
  status: z.enum(['queued', 'running', 'blocked', 'retry_pending']).default('queued'),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(2_000)).max(20).default([]),
  blockers: z.array(z.string().trim().min(1).max(2_000)).max(20).default([]),
  sourceMessageIds: z.array(z.string().trim().min(1).max(500)).max(32).default([]),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export const ContinuityPacketV2Schema = z.object({
  version: z.literal('continuity-v2'),
  sessionId: z.string().trim().min(1).max(220),
  turnId: z.string().trim().min(1).max(220),
  sourceCursor: z.string().trim().min(1).max(500),
  estimatedTokens: z.number().int().nonnegative().max(10_000_000),
  head: z.array(ContinuityMessageSchema).max(20).default([]),
  milestones: z.array(ContextMilestoneSchema).max(100).default([]),
  recentTail: z.array(ContinuityMessageSchema).max(160).default([]),
  activeToolState: z.array(ContinuityToolStateSchema).max(80).default([]),
  openWork: z.array(ContinuityOpenWorkSchema).max(80).default([]),
  previousCheckpointId: z.string().trim().min(1).max(500).optional(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export const ContinuityPacketV2PayloadSchema = ContinuityPacketV2Schema.omit({ contentHash: true });

export type ContinuityPacketV2 = z.infer<typeof ContinuityPacketV2Schema>;
export type ContinuityMessage = z.infer<typeof ContinuityMessageSchema>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function computeContinuityPacketHash(packet: ContinuityPacketV2): string {
  const rawHashable = Object.fromEntries(
    Object.entries(packet).filter(([key]) => key !== 'contentHash'),
  );
  const hashable = ContinuityPacketV2PayloadSchema.parse(rawHashable);
  return createHash('sha256').update(JSON.stringify(canonicalize(hashable))).digest('hex');
}

export function validateContinuityPacket(packet: ContinuityPacketV2): boolean {
  return computeContinuityPacketHash(packet) === packet.contentHash;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}

function size(message: ContinuityMessage): number {
  return message.content.length + (message.name?.length || 0) + 32;
}

function select(
  messages: ContinuityMessage[],
  maxChars: number,
  direction: 'head' | 'tail',
): ContinuityMessage[] {
  const source = direction === 'head' ? messages : [...messages].reverse();
  const kept: ContinuityMessage[] = [];
  let used = 0;
  for (const message of source) {
    const remaining = maxChars - used;
    if (remaining <= 64) break;
    const bounded = { ...message, content: clip(message.content, Math.min(24_000, remaining - 32)) };
    const messageChars = size(bounded);
    if (messageChars > remaining && kept.length) continue;
    kept.push(bounded);
    used += Math.min(messageChars, remaining);
  }
  return direction === 'head' ? kept : kept.reverse();
}

function evidence(ids: string[], hash: string): string {
  return `source_ids=${ids.length ? ids.join(',') : 'none'} source_hash=${hash}`;
}

export function continuityPacketToMessages(packet: ContinuityPacketV2, inputMaxChars = 120_000): ContinuityMessage[] {
  if (!validateContinuityPacket(packet)) throw new Error('ContinuityPacket v2 contentHash is invalid');
  const total = Math.max(20_000, Math.min(inputMaxChars, 500_000));
  const headBudget = Math.floor(total * 0.12);
  const milestoneBudget = Math.floor(total * 0.33);
  const toolBudget = Math.floor(total * 0.20);
  const tailBudget = total - headBudget - milestoneBudget - toolBudget;
  const header: ContinuityMessage = {
    role: 'system',
    message_id: `continuity:${packet.sourceCursor}`,
    content: [
      '[continuity-v2 packet]',
      `session_id=${packet.sessionId}`,
      `turn_id=${packet.turnId}`,
      `source_cursor=${packet.sourceCursor}`,
      `estimated_tokens=${packet.estimatedTokens}`,
      `previous_checkpoint_id=${packet.previousCheckpointId || ''}`,
      `content_hash=${packet.contentHash}`,
    ].join('\n'),
  };
  const milestoneMessages: ContinuityMessage[] = packet.milestones.map((item, index) => ({
    role: 'system',
    message_id: `milestone:${index}:${item.sourceHash.slice(0, 16)}`,
    content: clip(`[continuity-v2 milestone kind=${item.kind} occurred_at=${item.occurredAt} ${evidence(item.sourceMessageIds, item.sourceHash)}]\n${item.text}`, 24_000),
  }));
  const toolMessages: ContinuityMessage[] = packet.activeToolState.map((item) => ({
    role: 'tool',
    name: item.tool,
    message_id: `tool-state:${item.id}`,
    content: clip([
      `[continuity-v2 tool-state id=${item.id} status=${item.status} occurred_at=${item.occurredAt} ${evidence(item.sourceMessageIds, item.sourceHash)}]`,
      item.summary,
      item.changedFiles.length ? `changed_files=${item.changedFiles.join(',')}` : '',
      item.artifactIds.length ? `artifact_ids=${item.artifactIds.join(',')}` : '',
    ].filter(Boolean).join('\n'), 24_000),
  }));
  const workMessages: ContinuityMessage[] = packet.openWork.map((item) => ({
    role: 'system',
    message_id: `open-work:${item.id}`,
    content: clip([
      `[continuity-v2 open-work id=${item.id} kind=${item.kind} status=${item.status} ${evidence(item.sourceMessageIds, item.sourceHash)}]`,
      item.text,
      item.acceptanceCriteria.length ? `acceptance_criteria=${item.acceptanceCriteria.join(' | ')}` : '',
      item.blockers.length ? `blockers=${item.blockers.join(' | ')}` : '',
    ].filter(Boolean).join('\n'), 24_000),
  }));
  return [
    header,
    ...select(packet.head, Math.max(0, headBudget - size(header)), 'head'),
    ...select(milestoneMessages, milestoneBudget, 'head'),
    ...select([...toolMessages, ...workMessages], toolBudget, 'tail'),
    ...select(packet.recentTail, tailBudget, 'tail'),
  ].slice(0, 400);
}
