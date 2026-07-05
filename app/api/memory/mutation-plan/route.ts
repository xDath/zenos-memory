import { NextRequest, NextResponse } from 'next/server';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { buildMutationPlan } from '../../../lib/memory-mutation';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();

  try {
    const body = await request.json();
    const content = String(body.content || '');
    if (!content.trim()) return NextResponse.json({ error: 'content is required' }, { status: 400 });

    const namespace = body.namespace || 'zenos';
    const limit = Math.min(500, Math.max(1, Number(body.limit || 200)));
    const engine = getMemoryEngine();
    const memories = await engine.list(namespace, limit);
    const plan = buildMutationPlan(content, memories);

    return NextResponse.json({
      success: true,
      namespace,
      mode: 'state-aware-mutation-plan',
      plan,
      candidates_checked: memories.length,
      superseded_candidates: memories.filter(memory => plan.supersedes_ids.includes(memory.id)),
      related_candidates: memories.filter(memory => plan.related_ids.includes(memory.id)),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to build mutation plan';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
