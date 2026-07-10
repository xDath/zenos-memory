import { NextRequest } from 'next/server';
import { z } from 'zod';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { errorResponse, requestId } from '../../../lib/errors';
import { jsonResponse } from '../../../lib/http';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { buildDedupPlan } from '../../../lib/memory-maintainer';

const MergeSchema = z.object({
  namespace: z.string().optional().default('zenos'),
  apply: z.boolean().optional().default(false),
  max_apply: z.number().int().positive().max(20).optional().default(5),
});

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    const parsed = MergeSchema.parse(await request.json().catch(() => ({})));
    const engine = getMemoryEngine();
    const memories = await engine.recall({
      query: '',
      namespace: parsed.namespace,
      limit: 5000,
      include_low_quality: true,
      include_archived: false,
    });
    const plan = buildDedupPlan(memories);
    const applied: Array<{ keep: string; merge: string }> = [];

    if (parsed.apply) {
      const byId = new Map(memories.map(memory => [memory.id, memory]));
      for (const item of plan.slice(0, parsed.max_apply)) {
        const keep = byId.get(item.keep);
        const merge = byId.get(item.merge);
        if (!keep || !merge || keep.namespace !== merge.namespace) continue;
        const content = keep.content.includes(merge.content)
          ? keep.content
          : `${keep.content}\n\n${merge.content}`;
        const updated = await engine.edit(keep.id, {
          content,
          metadata: {
            related_ids: [...new Set([...(keep.metadata.related_ids || []), ...(merge.metadata.related_ids || [])])],
            supersedes_ids: [...new Set([...(keep.metadata.supersedes_ids || []), merge.id])],
            tags: [...new Set([...(keep.metadata.tags || []), ...(merge.metadata.tags || [])])],
            confidence: Math.max(keep.metadata.confidence, merge.metadata.confidence),
            importance: Math.max(keep.metadata.importance, merge.metadata.importance),
          },
        }, parsed.namespace, keep.metadata.version);
        if (!updated) continue;
        await engine.forget(merge.id, parsed.namespace, merge.metadata.version);
        applied.push({ keep: keep.id, merge: merge.id });
      }
    }

    return jsonResponse({
      success: true,
      namespace: parsed.namespace,
      dry_run: !parsed.apply,
      plan,
      applied,
      request_id: id,
    }, { requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
