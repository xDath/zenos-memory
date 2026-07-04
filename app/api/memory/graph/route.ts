import { NextRequest, NextResponse } from 'next/server';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { buildTemporalGraph } from '../../../lib/advanced-memory';

export async function GET(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();

  const { searchParams } = new URL(request.url);
  const namespace = searchParams.get('namespace') || 'zenos';
  const limit = Math.min(500, parseInt(searchParams.get('limit') || '200'));

  try {
    const engine = getMemoryEngine();
    const memories = await engine.recall({ query: '', namespace, limit, include_low_quality: true, include_secrets: true });
    const graph = buildTemporalGraph(memories);

    return NextResponse.json({
      success: true,
      namespace,
      graph: {
        nodes: graph.nodes.slice(0, 120),
        edges: graph.edges.slice(0, 300),
        stats: graph.stats,
      },
      quality: {
        density: Number((graph.edges.length / Math.max(1, graph.nodes.length)).toFixed(3)),
        top_nodes: graph.nodes.slice(0, 10).map(n => ({ id: n.id, label: n.label, type: n.type, weight: n.weight })),
      },
    });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}
