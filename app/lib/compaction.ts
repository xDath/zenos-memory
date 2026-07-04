import { z } from 'zod';
import { Memory } from './schema';

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
  max_chars: z.number().int().positive().max(20000).optional().default(8000),
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
  'context reset zenos memory hermes compression auto-reset primary recovery auto-compact',
  'current active projects tuan zenos hermes memory preferences',
  'batang job hunt pearl mining llm.etla.me dashboard crypto ops captcha solver active state',
  'gass langsung no questions execution style keep hermes base zenos memory',
];

function normalizeContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') {
        const p = part as Record<string, unknown>;
        return String(p.text || p.content || p.type || '');
      }
      return String(part ?? '');
    }).join(' ');
  }
  if (content && typeof content === 'object') {
    try { return JSON.stringify(content); } catch { return String(content); }
  }
  return String(content ?? '');
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
  metadata: any;
  blocks: {
    facts: string[];
    tasks: string[];
    decisions: string[];
    questions: string[];
    topics: string[];
  };
}

function extractBlocks(messages: CompactRequest['messages'], maxPerBlock = 6) {
  const facts: string[] = [];
  const tasks: string[] = [];
  const decisions: string[] = [];
  const questions: string[] = [];
  const topics = new Set<string>();

  const lower = (s: string) => s.toLowerCase();

  for (const msg of messages.slice(-60)) {
    const text = normalizeContent(msg.content);
    if (!text || text.length < 12) continue;

    const t = lower(text);

    // Topics (simple keyword detection)
    if (t.includes('batang') || t.includes('job') || t.includes('loker')) topics.add('batang-job-hunt');
    if (t.includes('pearl') || t.includes('mining') || t.includes('prl')) topics.add('pearl-mining');
    if (t.includes('llm.etla') || t.includes('valorant') || t.includes('combo')) topics.add('llm-dashboard');
    if (t.includes('hermes') || t.includes('zenos memory') || t.includes('compact')) topics.add('hermes-memory');
    if (t.includes('captcha') || t.includes('solver')) topics.add('captcha-solver');

    // Memory blocks
    if ((t.includes('prefer') || t.includes('suka') || t.includes('always')) && facts.length < maxPerBlock) {
      facts.push(text.slice(0, 180));
    }
    if ((t.includes('todo') || t.includes('harus') || t.includes('next') || t.includes('akan')) && tasks.length < maxPerBlock) {
      tasks.push(text.slice(0, 160));
    }
    if ((t.includes('decide') || t.includes('putus') || t.includes('final') || t.includes('sudah')) && decisions.length < maxPerBlock) {
      decisions.push(text.slice(0, 160));
    }
    if ((t.includes('?') || t.includes('belum') || t.includes('masih')) && questions.length < maxPerBlock) {
      questions.push(text.slice(0, 140));
    }
  }

  return {
    facts: facts.slice(0, maxPerBlock),
    tasks: tasks.slice(0, maxPerBlock),
    decisions: decisions.slice(0, maxPerBlock),
    questions: questions.slice(0, maxPerBlock),
    topics: Array.from(topics).slice(0, 8),
  };
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

  const content = [header, ...sections].join('\n\n').slice(0, maxChars);

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
    },
    blocks,
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
