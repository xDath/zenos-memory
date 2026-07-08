import { NextRequest, NextResponse } from 'next/server';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';
import { callMemoryLLM, hasMemoryLLM } from '../../../lib/memory-llm';

function scoreAnswer(answer: string) {
  const required = ['Zenos Memory', 'Agent Context OS', 'roadmap', 'compact', 'bootstrap', 'eval'];
  const forbidden = ['new project', 'better model'];
  const lower = answer.toLowerCase();
  const requiredHits = required.filter(term => lower.includes(term.toLowerCase())).length;
  const forbiddenHits = forbidden.filter(term => lower.includes(term.toLowerCase())).length;
  return { required_hits: requiredHits, forbidden_hits: forbiddenHits, score: requiredHits / required.length - forbiddenHits * 0.25 };
}

async function ask(prompt: string) {
  const result = await callMemoryLLM([
    { role: 'system', content: 'Answer briefly. If Zenos Memory Bootstrap is present, treat it as source of truth. Return JSON: {"answer":"..."}' },
    { role: 'user', content: prompt },
  ]);
  const answer = typeof result.parsed?.answer === 'string' ? result.parsed.answer : (result.content || '');
  return { ok: result.ok, model: result.model, answer, score: scoreAnswer(answer), error: result.error };
}

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const body = await request.json().catch(() => ({}));
  const bootstrap = String(body.bootstrap || '');
  const question = String(body.question || 'Lanjut project kemarin. Apa targetnya?');

  if (!hasMemoryLLM()) {
    return NextResponse.json({
      success: false,
      skipped: true,
      reason: 'MEMORY_LLM_* not configured',
      note: 'Use /api/memory/benchmark for deterministic intelligence-amplification baseline.',
    });
  }

  const without_memory = await ask(question);
  const with_memory = await ask(`${bootstrap}\n\nUser asks: ${question}`);
  const improvement = with_memory.score.score - without_memory.score.score;

  return NextResponse.json({
    success: with_memory.ok && without_memory.ok && improvement > 0,
    benchmark: 'zenos-memory-real-llm-ab-eval-v1',
    model: with_memory.model || without_memory.model,
    improvement,
    without_memory,
    with_memory,
  });
}
