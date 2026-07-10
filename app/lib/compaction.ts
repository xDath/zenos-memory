import { z } from 'zod';
import { Memory } from './schema';
import { redactSensitiveText as redactSecrets } from './secrets';

export const CompactMessageSchema = z.object({
  role: z.string().default('unknown'),
  content: z.any(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
});

export const CompactRequestSchema = z.object({
  messages: z.array(CompactMessageSchema).min(1),
  namespace: z.string().optional().default('zenos'),
  reason: z.string().optional().default('auto-compact'),
  approx_tokens: z.number().int().positive().optional(),
  session_id: z.string().optional(),
  conversation_id: z.string().optional(),
  max_chars: z.number().int().positive().max(24000).optional().default(10000),
  mode: z.enum(['deterministic', 'advanced', 'dag']).optional().default('dag'),
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
  for (const msg of messages.slice(-120)) {
    const text = normalizeContent(msg.content);
    for (const [topic, re] of TOPIC_PATTERNS) {
      if (re.test(text)) scores.set(topic, (scores.get(topic) || 0) + (msg.role === 'user' ? 3 : 1));
    }
  }
  return Array.from(scores.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([topic]) => topic);
}

function extractBlocks(messages: CompactRequest['messages'], maxPerBlock = 8) {
  const facts: string[] = [];
  const tasks: string[] = [];
  const decisions: string[] = [];
  const questions: string[] = [];
  const artifacts: string[] = [];
  const timeline: string[] = [];
  const topics = inferTopics(messages);

  for (const msg of messages.slice(-120)) {
    const role = String(msg.role || 'unknown');
    const text = normalizeContent(msg.content);
    if (!text || text.length < 10) continue;
    if (role === 'user') uniquePush(timeline, `User: ${text}`, 10, 180);
    if (role === 'assistant' && /(done|implemented|fixed|created|updated|deployed|tested|sukses|selesai)/i.test(text)) {
      uniquePush(timeline, `Assistant: ${text}`, 10, 180);
    }

    if (/(prefer|suka|always|jangan|harus|wants?|pengen|preference|style)/i.test(text)) uniquePush(facts, text, maxPerBlock, 240);
    if (/(todo|next|lanjut|gass|fix|implement|deploy|push|test|bikin|tambahkan|upgrade)/i.test(text)) uniquePush(tasks, text, maxPerBlock, 220);
    if (/(decided|final|sudah|done|selesai|approved|confirmed|pakai|gunakan|primary|fallback)/i.test(text)) uniquePush(decisions, text, maxPerBlock, 220);
    if (/[?？]|(belum|masih|kenapa|gimana|apakah|bisa ga|cek sekalian)/i.test(text)) uniquePush(questions, text, maxPerBlock, 180);
    if (/(\/root\/|app\/|api\/|\.ts|\.py|vercel|github|drive|folder|endpoint|env)/i.test(text)) uniquePush(artifacts, text, maxPerBlock, 220);
  }

  return { facts, tasks, decisions, questions, topics, artifacts, timeline };
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

  if (blocks.facts.length) sections.push('## Key Facts\n' + blocks.facts.map(f => `- ${f}`).join('\n'));
  if (blocks.tasks.length) sections.push('## Active Tasks\n' + blocks.tasks.map(t => `- ${t}`).join('\n'));
  if (blocks.decisions.length) sections.push('## Key Decisions\n' + blocks.decisions.map(d => `- ${d}`).join('\n'));
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
  const chunks = chunkMessages(messages.slice(-180), 12);
  const leafNodes = chunks.map((chunk, idx) => {
    const summary = summarizeChunk(chunk);
    return {
      id: `leaf-${idx + 1}`,
      level: 0,
      topic: topics[0] || 'general',
      summary,
      source_range: [chunk.start, chunk.end] as [number, number],
    };
  }).filter(n => n.summary.trim().length > 0);

  const rootSummary = leafNodes.map(n => n.summary).join(' || ').slice(0, 1600);
  const rootNode = {
    id: 'root-working-pack',
    level: 1,
    topic: topics.join(',') || 'general',
    summary: rootSummary,
    source_range: [0, Math.max(0, messages.length - 1)] as [number, number],
  };

  return { topics, nodes: [...leafNodes.slice(-12), rootNode] };
}

export function buildDagCompactSnapshot(req: CompactRequest): AdvancedCompactResult {
  const maxChars = req.max_chars || 10000;
  const blocks = extractBlocks(req.messages, 10);
  const dag = buildCompactionDag(req.messages);
  const workingPack = [
    ...(blocks.tasks || []).map(x => `Task: ${x}`),
    ...(blocks.decisions || []).map(x => `Decision: ${x}`),
    ...(blocks.facts || []).map(x => `Fact: ${x}`),
    ...(blocks.artifacts || []).map(x => `Artifact: ${x}`),
  ].slice(0, 18);

  const topicArchives: Record<string, string[]> = {};
  for (const topic of dag.topics.length ? dag.topics : ['general']) {
    topicArchives[topic] = dag.nodes.filter(n => n.topic.includes(topic) || n.id === 'root-working-pack').map(n => n.summary).slice(0, 6);
  }

  const now = new Date().toISOString();
  const sections = [
    `Zenos Compaction DAG v3`,
    `Created: ${now}`,
    `Mode: dag`,
    `Strategy: topic-aware-compaction-dag-working-pack-v3`,
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
      confidence: 0.94,
      importance: 10,
      tags: ['dag-compact', 'working-pack', 'topic-archive', 'lossless-style', 'codex-plus'],
      provenance: { session_id: req.session_id, conversation_id: req.conversation_id, created_by: 'zenos-memory-v3' },
      approx_tokens: req.approx_tokens,
      message_count: req.messages.length,
      reason: req.reason,
      compact_strategy: 'topic-aware-compaction-dag-working-pack-v3',
      topics: dag.topics,
      node_count: dag.nodes.length,
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
