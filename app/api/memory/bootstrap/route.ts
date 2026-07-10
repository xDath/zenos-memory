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
    const queries = [
      'structured compact handoff recovery current goal pending decisions',
      ...defaultBootstrapQueries(parsed.queries),
    ];
    for (const query of queries.slice(0, 8)) {
      const results = await engine.recallWithQuality({
        query,
        namespace: parsed.namespace,
        limit: parsed.limit,
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
