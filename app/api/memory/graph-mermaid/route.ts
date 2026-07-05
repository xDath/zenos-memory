import { NextRequest, NextResponse } from 'next/server';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { buildTemporalGraph } from '../../../lib/advanced-memory';

function clean(id: string) {
  return id.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 48) || 'node';
}

export async function GET(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const { searchParams } = new URL(request.url);
  const namespace = searchParams.get('namespace') || 'zenos';
  const limit = Math.min(80, Number(searchParams.get('limit') || 40));
  const engine = getMemoryEngine();
  const memories = await engine.recall({ query: '', namespace, limit: 500, include_low_quality: true, include_secrets: true });
  const graph = buildTemporalGraph(memories);
  const nodes = graph.nodes.slice(0, limit);
  const nodeIds = new Set(nodes.map(n => n.id));
  const edges = graph.edges.filter(e => nodeIds.has(e.source) && nodeIds.has(e.target)).slice(0, limit * 2);
  const lines = ['graph TD'];
  for (const n of nodes) lines.push(`  ${clean(n.id)}["${String(n.label).replace(/"/g, '\\"').slice(0, 70)}"]`);
  for (const e of edges) lines.push(`  ${clean(e.source)} -->|${e.type}:${e.weight.toFixed(1)}| ${clean(e.target)}`);
  return new NextResponse(lines.join('\n'), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
