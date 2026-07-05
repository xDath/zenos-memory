import { NextRequest, NextResponse } from 'next/server';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { buildDedupPlan } from '../../../lib/memory-maintainer';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const body = await request.json().catch(() => ({}));
  const namespace = body.namespace || 'zenos';
  const apply = !!body.apply;
  const engine = getMemoryEngine();
  const memories = await engine.recall({ query: '', namespace, limit: 500, include_low_quality: true, include_secrets: true });
  const plan = buildDedupPlan(memories);
  const applied: any[] = [];

  if (apply) {
    for (const item of plan.slice(0, Math.min(20, Number(body.max_apply || 5)))) {
      const keep = memories.find(m => m.id === item.keep);
      const merge = memories.find(m => m.id === item.merge);
      if (!keep || !merge) continue;
      const mergedContent = keep.content.includes(merge.content) ? keep.content : `${keep.content}\n\nMerged duplicate (${merge.id}): ${merge.content}`;
      const related_ids = Array.from(new Set([...(keep.metadata.related_ids || []), merge.id, ...(merge.metadata.related_ids || [])]));
      await engine.edit(keep.id, {
        content: mergedContent,
        metadata: { ...keep.metadata, related_ids, supersedes_ids: Array.from(new Set([...(keep.metadata.supersedes_ids || []), merge.id])) },
      } as any, namespace);
      await engine.forget(merge.id, namespace);
      applied.push(item);
    }
  }

  return NextResponse.json({ success: true, namespace, apply, plan, applied });
}
