import { NextRequest, NextResponse } from 'next/server';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { productionReadiness } from '../../../lib/advanced-memory';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();

  try {
    const body = await request.json().catch(() => ({}));
    const namespace = body.namespace || 'zenos';
    const engine = getMemoryEngine();
    const memories = await engine.recall({ query: '', namespace, limit: 500, include_low_quality: true, include_secrets: true });
    const readiness = productionReadiness(memories);

    return NextResponse.json({
      success: true,
      namespace,
      test: body.test || 'advanced-readiness',
      readiness,
      features: {
        compact_structured: readiness.evals.find(e => e.name === 'structured_compaction')?.status || 'unknown',
        temporal_graph: readiness.evals.find(e => e.name === 'temporal_graph_density')?.status || 'unknown',
        vector_search: readiness.evals.find(e => e.name === 'vector_readiness')?.status || 'unknown',
        credential_awareness: readiness.evals.find(e => e.name === 'credential_awareness')?.status || 'unknown',
      },
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message || String(error) }, { status: 500 });
  }
}
