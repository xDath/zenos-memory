import { NextRequest } from 'next/server';
import { buildTemporalGraph } from '../../../lib/advanced-memory';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { errorResponse, requestId } from '../../../lib/errors';
import { jsonResponse, parsePositiveInteger } from '../../../lib/http';
import { getMemoryEngine } from '../../../lib/memory-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    const url = new URL(request.url);
    const namespace = url.searchParams.get('namespace') || 'zenos';
    const limit = parsePositiveInteger(url.searchParams.get('limit'), 500, 5000);
    const memories = await getMemoryEngine().recall({
      query: '',
      namespace,
      limit,
      include_low_quality: true,
      include_archived: true,
    });
    const graph = buildTemporalGraph(memories);
    return jsonResponse({
      success: true,
      namespace,
      graph,
      quality: {
        density: Number((graph.edges.length / Math.max(1, graph.nodes.length)).toFixed(4)),
        explicit_edges: graph.edges.filter(edge => edge.type !== 'temporal_next').length,
      },
      request_id: id,
    }, { requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
