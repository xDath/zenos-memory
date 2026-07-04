import { NextRequest, NextResponse } from 'next/server';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';
import { rateLimit } from '../../../lib/rate-limit';
import { BootstrapRequestSchema, defaultBootstrapQueries, renderBootstrapBlock } from '../../../lib/compaction';
import { Memory } from '../../../lib/schema';

export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for') || 'unknown';
  if (!rateLimit(ip)) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  if (!validateApiKey(request)) return unauthorizedResponse();

  try {
    const body = await request.json();
    const parsed = BootstrapRequestSchema.parse(body);
    const engine = getMemoryEngine();
    const byId = new Map<string, Memory>();

    for (const query of defaultBootstrapQueries(parsed.queries)) {
      const results = await engine.recall({
        query,
        namespace: parsed.namespace,
        limit: parsed.limit,
      });
      for (const mem of results) byId.set(mem.id, mem);
    }

    const memories = Array.from(byId.values()).sort((a, b) => {
      const ia = a.metadata.importance || 0;
      const ib = b.metadata.importance || 0;
      if (ib !== ia) return ib - ia;
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });
    const bootstrap = renderBootstrapBlock(memories, parsed.namespace, parsed.max_chars);

    return NextResponse.json({
      success: true,
      bootstrap,
      count: memories.length,
      sources: memories.slice(0, parsed.limit).map((m) => ({
        id: m.id,
        type: m.type,
        content: m.content,
        importance: m.metadata.importance,
        tags: m.metadata.tags,
        updated_at: m.updated_at,
      })),
    });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return NextResponse.json({ error: 'Validation error', details: error.errors }, { status: 400 });
    }
    return NextResponse.json({ error: 'Failed to bootstrap', details: error.message }, { status: 500 });
  }
}
