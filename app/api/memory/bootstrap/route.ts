import { NextRequest } from 'next/server';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { BootstrapRequestSchema, defaultBootstrapQueries, renderBootstrapBlock } from '../../../lib/compaction';
import { errorResponse, requestId } from '../../../lib/errors';
import { enforceRateLimit, jsonResponse } from '../../../lib/http';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { Memory } from '../../../lib/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    enforceRateLimit(request, { bucket: 'bootstrap', limit: 90 });
    const parsed = BootstrapRequestSchema.parse(await request.json());
    const engine = getMemoryEngine();
    const selected = new Map<string, Memory>();

    // The newest structured checkpoint is the canonical continuity pointer.
    // Read it directly instead of paying for several broad semantic searches.
    const recent = await engine.list(parsed.namespace, Math.max(80, parsed.limit * 8));
    const latestCompact = recent.find((memory) => {
      const tags = memory.metadata.tags || [];
      return tags.includes('compact') || tags.includes('structured-handoff') || tags.includes('dag-compact');
    });
    if (latestCompact) selected.set(latestCompact.id, latestCompact);

    // At most one semantic recall supplements the checkpoint with query-specific
    // evidence. This keeps bootstrap bounded and prevents near-duplicate results.
    const queries = defaultBootstrapQueries(parsed.queries);
    const query = queries.slice(0, 2).join(' ');
    if (query.trim()) {
      const results = await engine.recallWithQuality({
        query,
        namespace: parsed.namespace,
        limit: Math.max(3, parsed.limit),
      });
      for (const result of results) selected.set(result.id, result);
    }
    const memories = [...selected.values()]
      .sort((left, right) => {
        const importance = (right.metadata.importance || 0) - (left.metadata.importance || 0);
        return importance || right.updated_at.localeCompare(left.updated_at);
      })
      .slice(0, parsed.limit);
    const bootstrap = renderBootstrapBlock(memories, parsed.namespace, parsed.max_chars);
    const sources = memories.map(memory => ({
      id: memory.id,
      type: memory.type,
      importance: memory.metadata.importance,
      tags: memory.metadata.tags,
      updated_at: memory.updated_at,
    }));
    return jsonResponse({
      success: true,
      bootstrap,
      count: sources.length,
      sources,
      request_id: id,
    }, { requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
