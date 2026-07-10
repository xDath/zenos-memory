import { NextRequest } from 'next/server';
import { buildTemporalGraph, productionReadiness } from '../../../lib/advanced-memory';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { errorResponse, requestId } from '../../../lib/errors';
import { jsonResponse } from '../../../lib/http';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { buildMaintenanceReport } from '../../../lib/memory-maintainer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    const namespace = new URL(request.url).searchParams.get('namespace') || 'zenos';
    const engine = getMemoryEngine();
    const memories = await engine.recall({
      query: '',
      namespace,
      limit: 5000,
      include_low_quality: true,
      include_archived: true,
    });
    const graph = buildTemporalGraph(memories);
    const readiness = productionReadiness(memories);
    const maintenance = buildMaintenanceReport(memories);
    const service = await engine.readiness();
    const byType = memories.reduce<Record<string, number>>((accumulator, memory) => {
      accumulator[memory.type] = (accumulator[memory.type] || 0) + 1;
      return accumulator;
    }, {});
    return jsonResponse({
      success: true,
      namespace,
      dashboard: {
        memory_count: memories.length,
        by_type: byType,
        data_quality: readiness,
        service_readiness: service,
        graph: graph.stats,
        maintenance: maintenance.totals,
        top_entities: graph.nodes
          .filter(node => node.type === 'entity')
          .slice(0, 12)
          .map(node => ({ label: node.label, weight: node.weight })),
        recommendations: maintenance.recommendations,
      },
      request_id: id,
    }, { requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
