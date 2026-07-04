import { NextRequest, NextResponse } from 'next/server';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { queryGraph } from '../../../lib/memory-maintainer';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  try {
    const body = await request.json().catch(() => ({}));
    const query = body.query || '';
    const namespace = body.namespace || 'zenos';
    const limit = Math.min(50, Math.max(1, Number(body.limit || 10)));
    const engine = getMemoryEngine();
    const memories = await engine.recall({ query: '', namespace, limit: 500, include_low_quality: true, include_secrets: !!body.include_secrets });
    const result = queryGraph(memories, query, limit);
    return NextResponse.json({ success: true, namespace, ...result });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message || String(error) }, { status: 500 });
  }
}
