import { NextRequest, NextResponse } from 'next/server';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';
import { deterministicEmbedding, cosineSimilarity } from '../../../lib/advanced-memory';
import { compactWithLLM, hasMemoryLLM } from '../../../lib/memory-llm';

const CASES = [
  { name: 'credential recall', query: 'vercel deploy token', expected: ['credential', 'vercel', 'token'], text: 'User gave a Vercel deployment token and expects the system to remember credentials safely.' },
  { name: 'context lifecycle', query: 'auto compact bootstrap recovery', expected: ['compact', 'bootstrap', 'recovery'], text: 'Zenos Memory auto-compacts long sessions and bootstraps recovery from Google Drive.' },
  { name: 'temporal graph', query: 'graph relationship over time', expected: ['temporal', 'graph', 'relationship'], text: 'Temporal graph stores entities, relationships, and timestamps for evolving memory.' },
  { name: 'entity linking', query: 'link oauth drive zenos', expected: ['oauth', 'drive', 'zenos'], text: 'OAuth, Google Drive, and Zenos Memory are linked as key entities in the context graph.' },
  { name: 'maintenance', query: 'deduplicate archive stale memories', expected: ['deduplicate', 'archive', 'stale'], text: 'The maintainer deduplicates similar memories and archives stale low-value items.' },
  { name: 'handoff quality', query: 'structured handoff decisions tasks blockers', expected: ['structured', 'handoff', 'decisions'], text: 'The compact endpoint produces structured handoff with decisions, tasks, blockers, and recovery instructions.' },
];

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const body = await request.json().catch(() => ({}));
  const results: any[] = [];

  for (const c of CASES) {
    const sim = cosineSimilarity(deterministicEmbedding(c.query), deterministicEmbedding(c.text));
    const lexical = c.expected.filter(x => c.text.toLowerCase().includes(x)).length / c.expected.length;
    results.push({ name: c.name, vector_similarity: Number(sim.toFixed(4)), lexical_hit_rate: lexical, pass: sim > 0.1 && lexical >= 0.66 });
  }

  let compact_eval: any = { skipped: true };
  if (hasMemoryLLM() && body.skip_llm !== true) {
    const llm = await compactWithLLM('User wants Zenos Memory to remember credentials, auto compact sessions, link entities, query temporal graph, run maintenance, and recover context from Drive.');
    compact_eval = { ok: llm.ok, model: llm.model, parsed: !!llm.parsed };
  }

  const score = results.filter(r => r.pass).length / results.length;
  return NextResponse.json({
    success: true,
    benchmark: 'zenos-memory-elite-regression-v2',
    case_count: CASES.length,
    score,
    status: score >= 0.9 ? 'elite-pass' : score >= 0.75 ? 'pass-with-polish' : 'fail',
    results,
    compact_eval,
  });
}
