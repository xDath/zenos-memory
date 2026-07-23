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
    const url = new URL(request.url);
    const namespace = url.searchParams.get('namespace') || 'zenos';
    const detail = url.searchParams.get('detail') === 'full' ? 'full' : 'summary';
    const engine = getMemoryEngine();
    const resourcePolicy = await engine.resourcePolicyStatus();
    if (detail === 'summary') {
      return jsonResponse({
        success: true,
        namespace,
        dashboard: {
          mode: 'serverless-control-plane-summary',
          memory_count: null,
          by_type: {},
          data_quality: null,
          service_readiness: {
            status: 'operational',
            architecture: process.env.ZENOS_MEMORY_STORAGE_MODE === 'drive-events'
              ? 'vercel-compute-drive-event-store'
              : 'local-sqlite',
            detailed_probe: '/api/memory/health-check',
          },
          resource_policy: resourcePolicy,
          graph: null,
          maintenance: null,
          top_entities: [],
          recommendations: [
            'Use ?detail=full for an explicit Drive materialization and complete analytics.',
            'Use /api/memory/resource-policy for remote quota and durable usage counters.',
          ],
          analytics_endpoints: {
            stats: '/api/memory/stats',
            quality: '/api/memory/quality',
            insights: '/api/memory/insights',
            graph: '/api/memory/relationship-graph',
          },
        },
        request_id: id,
      }, { requestId: id });
    }
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
    const service = await engine.readiness(namespace);
    const byType = memories.reduce<Record<string, number>>((accumulator, memory) => {
      accumulator[memory.type] = (accumulator[memory.type] || 0) + 1;
      return accumulator;
    }, {});
    return jsonResponse({
      success: true,
      namespace,
      dashboard: {
        mode: 'full-materialized-analytics',
        memory_count: memories.length,
        by_type: byType,
        data_quality: readiness,
        service_readiness: service,
        resource_policy: resourcePolicy,
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
