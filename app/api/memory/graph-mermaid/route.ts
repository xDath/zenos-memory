import { NextRequest } from 'next/server';
import { buildTemporalGraph } from '../../../lib/advanced-memory';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { errorResponse, requestId } from '../../../lib/errors';
import { parsePositiveInteger } from '../../../lib/http';
import { getMemoryEngine } from '../../../lib/memory-engine';

function nodeId(id: string): string {
  return `n_${id.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 64) || 'node'}`;
}

function label(value: string): string {
  return value.replace(/["|\[\]{}]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    const url = new URL(request.url);
    const namespace = url.searchParams.get('namespace') || 'zenos';
    const limit = parsePositiveInteger(url.searchParams.get('limit'), 40, 100);
    const memories = await getMemoryEngine().recall({
      query: '',
      namespace,
      limit: 5000,
      include_low_quality: true,
      include_archived: true,
    });
    const graph = buildTemporalGraph(memories);
    const nodes = graph.nodes.slice(0, limit);
    const ids = new Set(nodes.map(node => node.id));
    const edges = graph.edges
      .filter(edge => ids.has(edge.source) && ids.has(edge.target))
      .slice(0, limit * 3);
    const lines = ['graph TD'];
    for (const node of nodes) lines.push(`  ${nodeId(node.id)}["${label(node.label)}"]`);
    for (const edge of edges) {
      lines.push(`  ${nodeId(edge.source)} -->|${label(edge.type)}| ${nodeId(edge.target)}`);
    }
    return new Response(lines.join('\n'), {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'x-request-id': id,
      },
    });
  } catch (error) {
    return errorResponse(error, id);
  }
}
