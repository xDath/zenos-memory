import { NextRequest, NextResponse } from 'next/server';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { vectorSearch } from '../../../lib/advanced-memory';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();

  try {
    const body = await request.json().catch(() => ({}));
    const query = body.query || '';
    const namespace = body.namespace || 'zenos';
    const limit = Math.min(50, Math.max(1, Number(body.limit || 10)));
    const type = body.type;

    const engine = getMemoryEngine();
    const memories = await engine.recall({
      query: '',
      namespace,
      limit: 500,
      type,
      include_low_quality: true,
      include_secrets: !!body.include_secrets,
    });

    const results = vectorSearch(query, memories, limit).map(r => ({
      id: r.id,
      content: r.text,
      vector_score: r.vector_score,
      metadata: r.metadata,
    }));

    return NextResponse.json({
      success: true,
      mode: 'advanced-deterministic-vector',
      query,
      namespace,
      count: results.length,
      results,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message || String(error) }, { status: 500 });
  }
}
