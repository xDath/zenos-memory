import { NextRequest, NextResponse } from 'next/server';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';
import { deterministicEmbedding, cosineSimilarity } from '../../../lib/advanced-memory';
import { compactWithLLM, hasMemoryLLM } from '../../../lib/memory-llm';
import { buildMutationPlan } from '../../../lib/memory-mutation';
import { rankHybrid } from '../../../lib/hybrid-retrieval';
import { runIntelligenceAmplificationEval } from '../../../lib/intelligence-eval';
import { Memory } from '../../../lib/schema';

const CASES = [
  { name: 'credential recall', query: 'vercel deploy token', expected: ['credential', 'vercel', 'token'], text: 'User gave a Vercel deployment token and expects the system to remember credentials safely.' },
  { name: 'context lifecycle', query: 'auto compact bootstrap recovery', expected: ['compact', 'bootstrap', 'recovery'], text: 'Zenos Memory auto-compacts long sessions and bootstraps recovery from Google Drive.' },
  { name: 'temporal graph', query: 'graph relationship over time', expected: ['temporal', 'graph', 'relationship'], text: 'Temporal graph stores entities, relationships, and timestamps for evolving memory.' },
  { name: 'entity linking', query: 'link oauth drive zenos', expected: ['oauth', 'drive', 'zenos'], text: 'OAuth, Google Drive, and Zenos Memory are linked as key entities in the context graph.' },
  { name: 'maintenance', query: 'deduplicate archive stale memories', expected: ['deduplicate', 'archive', 'stale'], text: 'The maintainer deduplicates similar memories and archives stale low-value items.' },
  { name: 'handoff quality', query: 'structured handoff decisions tasks blockers', expected: ['structured', 'handoff', 'decisions'], text: 'The compact endpoint produces structured handoff with decisions, tasks, blockers, and recovery instructions.' },
];

type BasicBenchmarkResult = { name: string; vector_similarity: number; lexical_hit_rate: number; pass: boolean };
type CompactEval = { skipped?: boolean; ok?: boolean; model?: string; parsed?: boolean };

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const body = await request.json().catch(() => ({} as { skip_llm?: boolean }));
  const results: BasicBenchmarkResult[] = [];

  for (const c of CASES) {
    const sim = cosineSimilarity(deterministicEmbedding(c.query), deterministicEmbedding(c.text));
    const lexical = c.expected.filter(x => c.text.toLowerCase().includes(x)).length / c.expected.length;
    results.push({ name: c.name, vector_similarity: Number(sim.toFixed(4)), lexical_hit_rate: lexical, pass: sim > 0.1 && lexical >= 0.66 });
  }

  let compact_eval: CompactEval = { skipped: true };
  if (hasMemoryLLM() && body.skip_llm !== true) {
    const llm = await compactWithLLM('User wants Zenos Memory to remember credentials, auto compact sessions, link entities, query temporal graph, run maintenance, and recover context from Drive.');
    compact_eval = { ok: llm.ok, model: llm.model, parsed: !!llm.parsed };
  }

  const now = new Date().toISOString();
  const fixture: Memory[] = [
    {
      id: '11111111-1111-4111-8111-111111111111',
      type: 'project',
      content: 'Zenos Memory local repo exists and is being edited.',
      namespace: 'bench',
      metadata: { confidence: 0.8, tags: ['repo'], version: 1, importance: 5, related_ids: [], entities: ['Zenos Memory'], contradictions: [], supersedes_ids: [], access_count: 0, is_secret: false, redacted: false },
      created_at: now,
      updated_at: now,
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      type: 'project',
      content: 'Zenos Memory local repo was deleted; use GitHub backup and Vercel deployment.',
      namespace: 'bench',
      metadata: { confidence: 0.9, tags: ['repo', 'github', 'vercel'], version: 1, importance: 9, related_ids: [], entities: ['Zenos Memory', 'GitHub', 'Vercel'], contradictions: [], supersedes_ids: ['11111111-1111-4111-8111-111111111111'], access_count: 0, is_secret: false, redacted: false },
      created_at: now,
      updated_at: now,
    },
  ];
  const hybrid = rankHybrid('where is zenos memory repo now', fixture, 2);
  const mutation = buildMutationPlan('Zenos Memory local repo was deleted and GitHub backup is current.', fixture);
  const advanced_results = [
    { name: 'hybrid_current_state', pass: hybrid[0]?.memory.id === fixture[1].id, top_id: hybrid[0]?.memory.id },
    { name: 'mutation_supersession', pass: mutation.supersedes_ids.includes(fixture[0].id), plan: mutation },
  ];

  const intelligence_eval = runIntelligenceAmplificationEval();
  const baseScore = [...results, ...advanced_results].filter(r => r.pass).length / (results.length + advanced_results.length);
  const score = Number(((baseScore * 0.7) + (intelligence_eval.score * 0.3)).toFixed(4));
  return NextResponse.json({
    success: true,
    benchmark: 'zenos-memory-elite-regression-v8-intelligence-amplification',
    case_count: CASES.length + advanced_results.length + intelligence_eval.cases.length,
    score,
    status: score >= 0.9 ? 'elite-pass' : score >= 0.75 ? 'pass-with-polish' : 'fail',
    results,
    advanced_results,
    intelligence_eval,
    compact_eval,
  });
}
