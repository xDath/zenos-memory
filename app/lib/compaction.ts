import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ContinuityPacketV2Schema,
  continuityPacketToMessages,
  validateContinuityPacket,
} from './continuity-packet';
import { Memory } from './schema';
import { redactSensitiveText as redactSecrets } from './secrets';

export const CompactMessageSchema = z.object({
  role: z.string().default('unknown'),
  content: z.any(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  message_id: z.string().optional(),
});

const CompactRequestBaseSchema = z.object({
  messages: z.array(CompactMessageSchema).max(400).optional().default([]),
  continuity_packet: ContinuityPacketV2Schema.optional(),
  source_cursor: z.string().trim().min(1).max(500).optional(),
  previous_checkpoint_id: z.string().trim().min(1).max(500).optional(),
  namespace: z.string().optional().default('zenos'),
  reason: z.string().optional().default('auto-compact'),
  approx_tokens: z.number().int().positive().optional(),
  session_id: z.string().optional(),
  conversation_id: z.string().optional(),
  max_chars: z.number().int().positive().max(24000).optional().default(10000),
  input_max_chars: z.number().int().positive().max(500000).optional(),
  mode: z.enum(['deterministic', 'advanced', 'dag']).optional().default('dag'),
}).superRefine((request, context) => {
  if (!request.messages.length && !request.continuity_packet) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['messages'],
      message: 'Compact request requires messages or continuity_packet',
    });
    return;
  }
  const packetIntegrityValid = !request.continuity_packet
    || validateContinuityPacket(request.continuity_packet);
  if (!packetIntegrityValid) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['continuity_packet', 'contentHash'],
      message: 'ContinuityPacket v2 contentHash is invalid',
    });
  }
  if (
    request.continuity_packet
    && request.source_cursor
    && request.source_cursor !== request.continuity_packet.sourceCursor
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['source_cursor'],
      message: 'source_cursor does not match continuity_packet.sourceCursor',
    });
  }
  if (
    request.continuity_packet?.previousCheckpointId
    && request.previous_checkpoint_id
    && request.previous_checkpoint_id !== request.continuity_packet.previousCheckpointId
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['previous_checkpoint_id'],
      message: 'previous_checkpoint_id does not match continuity_packet.previousCheckpointId',
    });
  }
  const aggregateLimit = request.input_max_chars || 120_000;
  const messages = request.messages.length
    ? request.messages
    : request.continuity_packet && packetIntegrityValid
      ? continuityPacketToMessages(request.continuity_packet, aggregateLimit)
      : [];
  let aggregateChars = 0;
  for (const [index, message] of messages.entries()) {
    const chars = normalizeContent(message.content).length;
    aggregateChars += chars;
    if (chars > 32_000) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['messages', index, 'content'],
        message: 'Compact message content exceeds 32,000 normalized characters',
      });
    }
  }
  if (aggregateChars > aggregateLimit) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['messages'],
      message: `Compact source exceeds input_max_chars (${aggregateChars} > ${aggregateLimit})`,
    });
  }
});

export const CompactRequestSchema = CompactRequestBaseSchema.transform((request) => {
  const resolved = {
    ...request,
    messages: request.messages.length
      ? request.messages
      : request.continuity_packet
        ? continuityPacketToMessages(request.continuity_packet, request.input_max_chars || 120_000)
        : [],
  };
  if (!resolved.source_cursor && request.continuity_packet) resolved.source_cursor = request.continuity_packet.sourceCursor;
  if (!resolved.previous_checkpoint_id && request.continuity_packet?.previousCheckpointId) {
    resolved.previous_checkpoint_id = request.continuity_packet.previousCheckpointId;
  }
  if (!resolved.session_id && request.continuity_packet) resolved.session_id = request.continuity_packet.sessionId;
  if (!resolved.conversation_id && request.continuity_packet) resolved.conversation_id = request.continuity_packet.turnId;
  if (!resolved.approx_tokens && request.continuity_packet?.estimatedTokens) {
    resolved.approx_tokens = request.continuity_packet.estimatedTokens;
  }
  return resolved;
});

export const BootstrapRequestSchema = z.object({
  namespace: z.string().optional().default('zenos'),
  queries: z.array(z.string()).optional(),
  limit: z.number().int().positive().max(30).optional().default(12),
  max_chars: z.number().int().positive().max(12000).optional().default(3000),
});

export type CompactRequest = z.infer<typeof CompactRequestSchema>;
export type BootstrapRequest = z.infer<typeof BootstrapRequestSchema>;

const DEFAULT_BOOTSTRAP_QUERIES = [
  'current goals active projects decisions blockers next steps',
  'user preferences communication style durable instructions',
  'recent completed work files services deployments active state',
  'context recovery compact handoff unresolved questions',
];

export function redactSensitiveText(text: string): string {
  return redactSecrets(text);
}

export function normalizeContent(content: unknown): string {
  if (typeof content === 'string') return redactSensitiveText(content);
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return redactSensitiveText(part);
      if (part && typeof part === 'object') {
        const p = part as Record<string, unknown>;
        return redactSensitiveText(String(p.text || p.content || p.type || ''));
      }
      return redactSensitiveText(String(part ?? ''));
    }).join(' ');
  }
  if (content && typeof content === 'object') {
    try { return redactSensitiveText(JSON.stringify(content)); } catch { return redactSensitiveText(String(content)); }
  }
  return redactSensitiveText(String(content ?? ''));
}

const CONTINUATION_ONLY = /^(?:g+a+s+|lanjut(?:kan)?|continue|coba lagi|ulang|terusin|next|udah|sudah|cek lagi|go)(?:\s+(?:dong|aja|dulu|ya|lah))?[.!?]*$/i;
const GOAL_SIGNAL = /\b(?:buat|bikin|fix|perbaiki|implement|upgrade|audit|deploy|ubah|tambahkan|hapus|selesaikan|kerjakan|build|debug|investigate|tujuan|goal|harus|pengen|mau)\b/i;
const EVIDENCE_SIGNALS: Record<string, RegExp> = {
  decision: /\b(?:decision|decided|final|approved|confirmed|pilih|pakai|gunakan|diputuskan|keputusan)\b/i,
  task: /\b(?:todo|pending|next|lanjut|fix|implement|deploy|push|test|bikin|tambahkan|upgrade|repair|rollback|blocker)\b/i,
  question: /[?？]|\b(?:kenapa|gimana|apakah|belum|masih|bisa ga|cek sekalian|unknown|open question)\b/i,
  artifact: /(?:\/srv\/|\/root\/|app\/|api\/|scripts\/|\.tsx?\b|\.py\b|\.json\b|vercel|github|drive|endpoint|service\b|env\b)/i,
  failure: /\b(?:error|failed|failure|timeout|denied|broken|invalid|regression|bug|crash|ngadat|gagal|rusak)\b/i,
  constraint: /\b(?:must|must not|do not|never|always|jangan|harus|wajib|tanpa|only|hanya)\b/i,
};

export type CompactionEvidencePacket = {
  text: string;
  currentGoal: string;
  sourceMessages: number;
  selectedMessages: number;
  omittedMessages: number;
  sourceChars: number;
  selectedChars: number;
  anchors: string[];
  categoryCounts: Record<string, number>;
  selectedCategoryCounts: Record<string, number>;
  categoryCoverage: Record<string, number>;
};

type CompactionEntry = {
  index: number;
  role: string;
  text: string;
  anchor: string;
  categories: string[];
  score: number;
};

function compactionEntries(messages: CompactRequest['messages']): CompactionEntry[] {
  const total = Math.max(1, messages.length);
  return messages.map((message, index) => {
    const role = String(message.role || 'unknown').toLowerCase();
    const text = normalizeContent(message.content).replace(/\s+/g, ' ').trim();
    const categories = Object.entries(EVIDENCE_SIGNALS)
      .filter(([, pattern]) => pattern.test(text))
      .map(([name]) => name);
    const recentness = index / total;
    const score = categories.length * 3
      + (role === 'user' ? 1.5 : role === 'tool' ? 1.2 : 0.5)
      + (GOAL_SIGNAL.test(text) ? 2.5 : 0)
      + recentness * 1.5;
    const fingerprint = createHash('sha256').update(`${role}\n${text}`).digest('hex').slice(0, 12);
    return { index, role, text, anchor: `m${index}:${role}:${fingerprint}`, categories, score };
  }).filter((entry) => Boolean(entry.text));
}

export function selectDurableUserGoal(messages: CompactRequest['messages']): string {
  const candidates: Array<{ index: number; text: string }> = [];
  for (const [index, message] of messages.entries()) {
    if (String(message.role || '').toLowerCase() !== 'user') continue;
    const text = normalizeContent(message.content).replace(/\s+/g, ' ').trim();
    if (!text || CONTINUATION_ONLY.test(text)) continue;
    candidates.push({ index, text });
  }
  if (!candidates.length) return '';

  const explicitGoal = [...candidates]
    .reverse()
    .find((candidate) => GOAL_SIGNAL.test(candidate.text));
  if (explicitGoal) return explicitGoal.text.slice(0, 2_000);

  const scored = candidates
    .map((candidate) => ({
      ...candidate,
      score: Math.min(candidate.text.length, 800)
        + (/[?？]/.test(candidate.text) ? 80 : 0)
        + candidate.index / Math.max(1, messages.length),
    }))
    .sort((left, right) => right.score - left.score || right.index - left.index)[0];
  return scored.text.slice(0, 2_000);
}

function renderEvidenceEntries(entries: CompactionEntry[]): string {
  const ordered = [...entries].sort((left, right) => left.index - right.index);
  const lines: string[] = [];
  let previous = -1;
  for (const entry of ordered) {
    if (previous >= 0 && entry.index > previous + 1) lines.push(`[messages ${previous + 1}-${entry.index - 1} omitted as lower signal]`);
    const clipped = entry.text.length > 1_600 ? `${entry.text.slice(0, 1_597)}...` : entry.text;
    lines.push(`[${entry.anchor}] ${clipped}`);
    previous = entry.index;
  }
  return lines.join('\n\n');
}

export function buildCompactionEvidencePacket(
  messages: CompactRequest['messages'],
  maxChars = 60_000,
): CompactionEvidencePacket {
  const entries = compactionEntries(messages);
  const boundedChars = Math.max(8_000, Math.min(maxChars, 120_000));
  const selected = new Map<number, CompactionEntry>();
  const seedIndexes = new Set<number>();
  const protectedIndexes = new Set<number>();
  for (const entry of entries.slice(0, 3)) seedIndexes.add(entry.index);
  for (const entry of entries.slice(-24)) seedIndexes.add(entry.index);
  const first = entries[0];
  if (first) protectedIndexes.add(first.index);
  for (const entry of entries.slice(-2)) protectedIndexes.add(entry.index);

  const durableGoal = selectDurableUserGoal(messages);
  if (durableGoal) {
    const goalEntry = [...entries].reverse().find((entry) => entry.role === 'user' && entry.text.includes(durableGoal.slice(0, 120)));
    if (goalEntry) {
      seedIndexes.add(goalEntry.index);
      protectedIndexes.add(goalEntry.index);
    }
  }

  for (const name of Object.keys(EVIDENCE_SIGNALS)) {
    entries
      .filter((entry) => entry.categories.includes(name))
      .sort((left, right) => right.score - left.score || right.index - left.index)
      .slice(0, 6)
      .forEach((entry) => seedIndexes.add(entry.index));
  }
  for (const entry of entries) if (seedIndexes.has(entry.index)) selected.set(entry.index, entry);

  const ranked = [...entries].sort((left, right) => right.score - left.score || right.index - left.index);
  for (const entry of ranked) {
    if (selected.has(entry.index)) continue;
    const candidate = [...selected.values(), entry];
    if (renderEvidenceEntries(candidate).length <= boundedChars) selected.set(entry.index, entry);
  }

  let rendered = renderEvidenceEntries([...selected.values()]);
  if (rendered.length > boundedChars) {
    const removable = [...selected.values()]
      .filter((entry) => !protectedIndexes.has(entry.index))
      .sort((left, right) => left.score - right.score || left.index - right.index);
    while (rendered.length > boundedChars && removable.length) {
      const entry = removable.shift();
      if (entry) selected.delete(entry.index);
      rendered = renderEvidenceEntries([...selected.values()]);
    }
  }
  if (rendered.length > boundedChars) {
    throw new Error('Compaction evidence packet could not satisfy the hard output bound');
  }

  const categoryCounts = Object.fromEntries(Object.keys(EVIDENCE_SIGNALS).map((name) => [
    name,
    entries.filter((entry) => entry.categories.includes(name)).length,
  ]));
  const selectedEntries = [...selected.values()];
  const selectedCategoryCounts = Object.fromEntries(Object.keys(EVIDENCE_SIGNALS).map((name) => [
    name,
    selectedEntries.filter((entry) => entry.categories.includes(name)).length,
  ]));
  const categoryCoverage = Object.fromEntries(Object.keys(EVIDENCE_SIGNALS).map((name) => {
    const total = categoryCounts[name] || 0;
    return [name, total ? Math.min(1, (selectedCategoryCounts[name] || 0) / total) : 1];
  }));

  return {
    text: rendered,
    currentGoal: durableGoal,
    sourceMessages: entries.length,
    selectedMessages: selectedEntries.length,
    omittedMessages: Math.max(0, entries.length - selectedEntries.length),
    sourceChars: entries.reduce((sum, entry) => sum + entry.text.length, 0),
    selectedChars: rendered.length,
    anchors: selectedEntries.sort((left, right) => left.index - right.index).map((entry) => entry.anchor),
    categoryCounts,
    selectedCategoryCounts,
    categoryCoverage,
  };
}

function compactLine(role: string, content: unknown, max = 520): string | null {
  const text = normalizeContent(content).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const clipped = text.length > max ? text.slice(0, max - 3) + '...' : text;
  return `${role}: ${clipped}`;
}

function pickImportant(messages: CompactRequest['messages'], maxChars: number) {
  const tail = messages.slice(-48);
  const userLines: string[] = [];
  const assistantLines: string[] = [];
  const toolLines: string[] = [];
  const seen = new Set<string>();

  for (const msg of tail) {
    const role = String(msg.role || 'unknown');
    const line = compactLine(role, msg.content);
    if (!line) continue;
    const key = line.toLowerCase().slice(0, 180);
    if (seen.has(key)) continue;
    seen.add(key);
    if (role === 'user') userLines.push(line);
    else if (role === 'assistant') assistantLines.push(line);
    else toolLines.push(line);
  }

  const ordered = [...userLines.slice(-18), ...assistantLines.slice(-18), ...toolLines.slice(-8)];
  const kept: string[] = [];
  for (const line of ordered) {
    if ((kept.join('\n').length + line.length + 1) > maxChars) break;
    kept.push(line);
  }
  return kept;
}

export function buildCompactSnapshot(req: CompactRequest) {
  const maxChars = req.max_chars || 8000;
  const lines = pickImportant(req.messages, Math.max(1200, maxChars - 900));
  const now = new Date().toISOString();
  const header = [
    `Zenos auto-compact snapshot (${req.reason || 'auto-compact'})`,
    `Created: ${now}`,
    `Approx tokens: ${req.approx_tokens || 'unknown'}`,
    `Messages seen: ${req.messages.length}`,
    req.session_id ? `Session: ${req.session_id}` : '',
    req.conversation_id ? `Conversation: ${req.conversation_id}` : '',
  ].filter(Boolean).join('\n');

  const content = `${header}\n\n## Recent durable handoff\n${lines.join('\n')}`.slice(0, maxChars);
  return {
    content,
    type: 'event' as const,
    metadata: {
      source: 'zenos-memory-compact-api',
      confidence: 0.9,
      importance: 9,
      tags: ['auto-compact', 'context-reset', 'hermes', 'codex-style'],
      provenance: {
        session_id: req.session_id,
        conversation_id: req.conversation_id,
        created_by: 'zenos-memory',
      },
      approx_tokens: req.approx_tokens,
      message_count: req.messages.length,
      reason: req.reason,
      compact_strategy: 'deterministic-tail-handoff-v1',
    },
  };
}

// ─────────────────────────────────────────────────────────────
// ADVANCED STRUCTURED COMPACT (Codex / Letta / MemGPT style)
// ─────────────────────────────────────────────────────────────

export interface AdvancedCompactResult {
  content: string;
  type: 'insight' | 'project' | 'event';
  metadata: Record<string, unknown>;
  blocks: {
    facts: string[];
    tasks: string[];
    decisions: string[];
    questions: string[];
    topics: string[];
    goals?: string[];
    constraints?: string[];
    validations?: string[];
    blockers?: string[];
    artifacts?: string[];
    timeline?: string[];
    working_pack?: string[];
    topic_archives?: Record<string, string[]>;
    compaction_nodes?: Array<{ id: string; level: number; topic: string; summary: string; source_range: [number, number] }>;
  };
}

const TOPIC_PATTERNS: Array<[string, RegExp]> = [
  ['career', /\b(job|career|application|interview|cv|resume|work|kerja|lamaran)\b/i],
  ['software-project', /\b(project|repo|code|build|bug|feature|architecture|database|api)\b/i],
  ['agent-memory', /\b(agent|memory|compact|compression|context|recovery|bootstrap|hermes|zenos)\b/i],
  ['operations', /\b(deploy|production|server|vps|service|incident|monitor|backup|restore)\b/i],
  ['security', /\b(auth|security|permission|credential|secret|token|vulnerability)\b/i],
  ['design-content', /\b(design|image|video|presentation|document|caption|thumbnail)\b/i],
];

function uniquePush(list: string[], value: string, max: number, clip = 220) {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (!clean) return;
  const clipped = clean.length > clip ? clean.slice(0, clip - 3) + '...' : clean;
  const key = clipped.toLowerCase().slice(0, 140);
  if (!list.some(x => x.toLowerCase().slice(0, 140) === key) && list.length < max) list.push(clipped);
}

function inferTopics(messages: CompactRequest['messages']) {
  const scores = new Map<string, number>();
  for (const [index, msg] of messages.entries()) {
    const text = normalizeContent(msg.content);
    const recency = messages.length <= 1 ? 0 : index / (messages.length - 1);
    for (const [topic, re] of TOPIC_PATTERNS) {
      if (re.test(text)) scores.set(topic, (scores.get(topic) || 0) + (msg.role === 'user' ? 3 : 1) + recency);
    }
  }
  return Array.from(scores.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([topic]) => topic);
}

function extractBlocks(messages: CompactRequest['messages'], maxPerBlock = 8) {
  const facts: string[] = [];
  const tasks: string[] = [];
  const decisions: string[] = [];
  const questions: string[] = [];
  const goals: string[] = [];
  const constraints: string[] = [];
  const validations: string[] = [];
  const blockers: string[] = [];
  const artifacts: string[] = [];
  const timeline: string[] = [];
  const topics = inferTopics(messages);

  // ContinuityPacket milestones are evidence-addressed contracts, not generic
  // prose. Reserve protected slots for every state-bearing milestone before
  // relevance-ranked filler is allowed to consume a block budget.
  for (const message of messages) {
    const text = normalizeContent(message.content).replace(/\s+/g, ' ').trim();
    const milestone = text.match(/^\[continuity-v2 milestone kind=(goal|decision|constraint|tool_result|patch|validation|blocker)\b[^\]]*\]\s*(.*)$/i);
    if (!milestone) continue;
    const kind = milestone[1].toLowerCase();
    const claim = milestone[2].trim();
    if (!claim) continue;
    if (kind === 'goal') uniquePush(goals, claim, 6, 420);
    if (kind === 'decision') uniquePush(decisions, claim, 8, 420);
    if (kind === 'constraint') uniquePush(constraints, claim, 8, 420);
    if (kind === 'validation') uniquePush(validations, claim, 8, 420);
    if (kind === 'blocker') uniquePush(blockers, claim, 8, 420);
    if (kind === 'patch' || kind === 'tool_result') uniquePush(artifacts, claim, 10, 420);
  }

  const ranked = compactionEntries(messages).sort((left, right) => right.score - left.score || right.index - left.index);
  for (const entry of ranked) {
    const role = entry.role;
    const text = entry.text;
    if (!text || text.length < 10) continue;
    if (role === 'user' && entry.index >= Math.max(0, messages.length - 40)) uniquePush(timeline, `User: ${text}`, 10, 180);
    if (role === 'assistant' && entry.index >= Math.max(0, messages.length - 60) && /(done|implemented|fixed|created|updated|deployed|tested|sukses|selesai)/i.test(text)) {
      uniquePush(timeline, `Assistant: ${text}`, 10, 180);
    }

    if (/(prefer|suka|always|jangan|harus|wants?|pengen|preference|style)/i.test(text)) uniquePush(facts, text, maxPerBlock, 240);
    if (/(current goal|objective|tujuan|todo|next|lanjut|gass|fix|implement|deploy|push|test|bikin|tambahkan|upgrade)/i.test(text)) uniquePush(tasks, text, maxPerBlock, 220);
    if (/(decision|decided|final|sudah|done|selesai|approved|confirmed|pakai|gunakan|primary|fallback)/i.test(text)) uniquePush(decisions, text, maxPerBlock, 220);
    if (/(blocker|blocked|failure|failed|error|timeout|menunggu|pending approval)/i.test(text)) uniquePush(blockers, text, maxPerBlock, 260);
    if (/(validation|validated|typecheck|lint|tests? passed|build passed)/i.test(text)) uniquePush(validations, text, maxPerBlock, 260);
    if (/[?？]|(belum|masih|kenapa|gimana|apakah|bisa ga|cek sekalian)/i.test(text)) uniquePush(questions, text, maxPerBlock, 180);
    if (/(\/root\/|app\/|api\/|\.ts|\.py|vercel|github|drive|folder|endpoint|env)/i.test(text)) uniquePush(artifacts, text, maxPerBlock, 220);
  }

  if (!goals.length) {
    const goal = tasks.find(item => /(current goal|objective|tujuan|upgrade|implement|fix)/i.test(item));
    if (goal) uniquePush(goals, goal, 6, 420);
  }
  for (const constraint of constraints) uniquePush(facts, constraint, maxPerBlock, 260);
  for (const validation of validations) uniquePush(tasks, validation, maxPerBlock, 260);
  for (const blocker of blockers) uniquePush(questions, blocker, maxPerBlock, 260);

  return { facts, tasks, decisions, questions, topics, goals, constraints, validations, blockers, artifacts, timeline };
}

export function buildAdvancedCompactSnapshot(req: CompactRequest): AdvancedCompactResult {
  const maxChars = req.max_chars || 9000;
  const blocks = extractBlocks(req.messages);
  const now = new Date().toISOString();

  const header = [
    `Zenos Advanced Compact (${req.reason || 'advanced'})`,
    `Created: ${now}`,
    `Tokens: ${req.approx_tokens || 'unknown'}`,
    `Topics: ${blocks.topics.join(', ') || 'general'}`,
    req.session_id ? `Session: ${req.session_id}` : '',
  ].filter(Boolean).join('\n');

  const sections: string[] = [];

  if (blocks.goals?.length) sections.push('## Active Goals\n' + blocks.goals.map(value => `- ${value}`).join('\n'));
  if (blocks.decisions.length) sections.push('## Key Decisions\n' + blocks.decisions.map(d => `- ${d}`).join('\n'));
  if (blocks.constraints?.length) sections.push('## Constraints\n' + blocks.constraints.map(value => `- ${value}`).join('\n'));
  if (blocks.validations?.length) sections.push('## Validation Evidence\n' + blocks.validations.map(value => `- ${value}`).join('\n'));
  if (blocks.blockers?.length) sections.push('## Blockers\n' + blocks.blockers.map(value => `- ${value}`).join('\n'));
  if (blocks.facts.length) sections.push('## Key Facts\n' + blocks.facts.map(f => `- ${f}`).join('\n'));
  if (blocks.tasks.length) sections.push('## Active Tasks\n' + blocks.tasks.map(t => `- ${t}`).join('\n'));
  if (blocks.questions.length) sections.push('## Open Questions\n' + blocks.questions.map(q => `- ${q}`).join('\n'));
  if (blocks.artifacts?.length) sections.push('## Files / Endpoints / Artifacts\n' + blocks.artifacts.map(a => `- ${a}`).join('\n'));
  if (blocks.timeline?.length) sections.push('## Recent Timeline\n' + blocks.timeline.map(t => `- ${t}`).join('\n'));

  const content = [header, 'Purpose: compact long context into active durable memory blocks while discarding low-signal chat history.', ...sections].join('\n\n').slice(0, maxChars);

  return {
    content,
    type: 'insight' as const,
    metadata: {
      source: 'zenos-memory-advanced-compact',
      confidence: 0.92,
      importance: 10,
      tags: ['advanced-compact', 'structured', 'memory-blocks', 'hermes', 'codex-style'],
      provenance: {
        session_id: req.session_id,
        conversation_id: req.conversation_id,
        created_by: 'zenos-memory-advanced',
      },
      approx_tokens: req.approx_tokens,
      message_count: req.messages.length,
      reason: req.reason,
      compact_strategy: 'advanced-structured-memory-blocks-v2',
      topics: blocks.topics,
      block_counts: { facts: blocks.facts.length, tasks: blocks.tasks.length, decisions: blocks.decisions.length, questions: blocks.questions.length, artifacts: blocks.artifacts?.length || 0 },
    },
    blocks,
  };
}

function chunkMessages(messages: CompactRequest['messages'], size = 12) {
  const chunks: Array<{ start: number; end: number; messages: CompactRequest['messages'] }> = [];
  for (let i = 0; i < messages.length; i += size) {
    chunks.push({ start: i, end: Math.min(i + size - 1, messages.length - 1), messages: messages.slice(i, i + size) });
  }
  return chunks;
}

function summarizeChunk(chunk: { start: number; end: number; messages: CompactRequest['messages'] }) {
  const lines: string[] = [];
  for (const msg of chunk.messages) {
    const role = String(msg.role || 'unknown');
    const text = normalizeContent(msg.content).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const important = /(gass|fix|implement|deploy|test|done|error|failed|decided|final|harus|pengen|context|compact|memory|github|vercel|drive)/i.test(text);
    if (important || role === 'user') uniquePush(lines, `${role}: ${text}`, 8, 240);
  }
  return lines.length ? lines.join(' | ') : chunk.messages.map(m => normalizeContent(m.content)).join(' ').slice(0, 280);
}

function buildCompactionDag(messages: CompactRequest['messages']) {
  const topics = inferTopics(messages);
  const chunks = chunkMessages(messages, 12);
  const candidates = chunks.map((chunk, idx) => {
    const summary = summarizeChunk(chunk);
    const chunkTopics = inferTopics(chunk.messages);
    const signalMatches = Object.values(EVIDENCE_SIGNALS).filter((pattern) => pattern.test(summary)).length;
    const recency = chunks.length <= 1 ? 0 : idx / (chunks.length - 1);
    return {
      id: `leaf-${idx + 1}`,
      level: 0,
      topic: chunkTopics.join(',') || topics[0] || 'general',
      summary,
      source_range: [chunk.start, chunk.end] as [number, number],
      score: signalMatches * 3 + recency * 2 + (idx === 0 || idx === chunks.length - 1 ? 2 : 0),
    };
  }).filter((node) => node.summary.trim().length > 0);

  const selectedIndexes = new Set<number>();
  if (candidates.length) selectedIndexes.add(0);
  if (candidates.length > 1) selectedIndexes.add(candidates.length - 1);
  candidates
    .map((node, index) => ({ node, index }))
    .sort((left, right) => right.node.score - left.node.score || right.index - left.index)
    .slice(0, 18)
    .forEach(({ index }) => selectedIndexes.add(index));

  const leafNodes = [...selectedIndexes]
    .sort((left, right) => left - right)
    .map((index) => candidates[index])
    .filter(Boolean)
    .map((node) => ({
      id: node.id,
      level: node.level,
      topic: node.topic,
      summary: node.summary,
      source_range: node.source_range,
    }));
  const rootSummary = leafNodes.map((node) => `[${node.source_range[0]}-${node.source_range[1]}] ${node.summary}`).join(' || ').slice(0, 3_200);
  const rootNode = {
    id: 'root-working-pack',
    level: 1,
    topic: topics.join(',') || 'general',
    summary: rootSummary,
    source_range: [0, Math.max(0, messages.length - 1)] as [number, number],
  };
  const sourceChunkCount = candidates.length;
  const selectedChunkCount = leafNodes.length;

  return {
    topics,
    nodes: [...leafNodes, rootNode],
    sourceChunkCount,
    selectedChunkCount,
    chunkCoverage: sourceChunkCount ? selectedChunkCount / sourceChunkCount : 1,
  };
}

export function buildDagCompactSnapshot(req: CompactRequest): AdvancedCompactResult {
  const maxChars = req.max_chars || 10000;
  const blocks = extractBlocks(req.messages, 10);
  const dag = buildCompactionDag(req.messages);
  const workingPack = [
    ...(blocks.goals || []).slice(0, 3).map(x => `Goal: ${x}`),
    ...(blocks.decisions || []).slice(0, 4).map(x => `Decision: ${x}`),
    ...(blocks.constraints || []).slice(0, 4).map(x => `Constraint: ${x}`),
    ...(blocks.validations || []).slice(0, 4).map(x => `Validation: ${x}`),
    ...(blocks.blockers || []).slice(0, 4).map(x => `Blocker: ${x}`),
    ...(blocks.tasks || []).slice(0, 4).map(x => `Task: ${x}`),
    ...(blocks.artifacts || []).slice(0, 6).map(x => `Artifact: ${x}`),
    ...(blocks.facts || []).slice(0, 3).map(x => `Fact: ${x}`),
  ];

  const topicArchives: Record<string, string[]> = {};
  for (const topic of dag.topics.length ? dag.topics : ['general']) {
    topicArchives[topic] = dag.nodes.filter(n => n.topic.includes(topic) || n.id === 'root-working-pack').map(n => n.summary).slice(0, 6);
  }

  const now = new Date().toISOString();
  const sections = [
    `Zenos Compaction DAG v3`,
    `Created: ${now}`,
    `Mode: dag`,
    `Strategy: evidence-ranked-compaction-dag-working-pack-v4`,
    `Approx tokens: ${req.approx_tokens || 'unknown'}`,
    `Topics: ${(dag.topics.length ? dag.topics : ['general']).join(', ')}`,
    req.session_id ? `Session: ${req.session_id}` : '',
    '',
    '## Working Pack (hot context to inject)',
    ...(workingPack.length ? workingPack.map(x => `- ${x}`) : ['- No explicit hot items extracted; use DAG root summary.']),
    '',
    '## Topic Archives',
    ...Object.entries(topicArchives).flatMap(([topic, summaries]) => [`### ${topic}`, ...summaries.map(s => `- ${s.slice(0, 360)}`)]),
    '',
    '## DAG Root Summary',
    dag.nodes[dag.nodes.length - 1]?.summary || '',
  ].filter(x => x !== undefined).join('\n').slice(0, maxChars);

  return {
    content: sections,
    type: 'insight' as const,
    metadata: {
      source: 'zenos-memory-dag-compact',
      confidence: 0.86,
      importance: 10,
      tags: ['dag-compact', 'working-pack', 'topic-archive', 'evidence-ranked', 'codex-plus'],
      provenance: { session_id: req.session_id, conversation_id: req.conversation_id, created_by: 'zenos-memory-v3' },
      approx_tokens: req.approx_tokens,
      message_count: req.messages.length,
      reason: req.reason,
      compact_strategy: 'evidence-ranked-compaction-dag-working-pack-v4',
      topics: dag.topics,
      node_count: dag.nodes.length,
      source_chunk_count: dag.sourceChunkCount,
      selected_chunk_count: dag.selectedChunkCount,
      source_chunk_coverage: dag.chunkCoverage,
      block_counts: { facts: blocks.facts.length, tasks: blocks.tasks.length, decisions: blocks.decisions.length, questions: blocks.questions.length, artifacts: blocks.artifacts?.length || 0 },
    },
    blocks: { ...blocks, working_pack: workingPack, topic_archives: topicArchives, compaction_nodes: dag.nodes },
  };
}

export function renderBootstrapBlock(memories: Memory[], namespace: string, maxChars: number) {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const m of memories) {
    const tags = Array.isArray(m.metadata.tags) && m.metadata.tags.length
      ? ` tags=${m.metadata.tags.slice(0, 5).join(',')}`
      : '';
    let line = `- [${m.type}] ${m.content}`;
    if (m.metadata.importance !== undefined) line += ` (importance=${m.metadata.importance})`;
    line += tags;
    if (line.length > 520) line = line.slice(0, 517) + '...';
    const key = line.toLowerCase().slice(0, 220);
    if (seen.has(key)) continue;
    seen.add(key);
    if ((lines.join('\n').length + line.length + 1) > maxChars) break;
    lines.push(line);
  }

  if (!lines.length) return '';
  return [
    '# Zenos Memory Bootstrap',
    'Primary persistent recall layer. Use this to recover continuity after context compaction, compression failure, or session auto-reset.',
    `Namespace: ${namespace}`,
    ...lines,
  ].join('\n');
}

export function defaultBootstrapQueries(queries?: string[]) {
  return queries && queries.length ? queries : DEFAULT_BOOTSTRAP_QUERIES;
}
