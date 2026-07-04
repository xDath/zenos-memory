import { NextRequest, NextResponse } from 'next/server';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { buildTemporalGraph, productionReadiness } from '../../../lib/advanced-memory';
import { buildMaintenanceReport } from '../../../lib/memory-maintainer';

export async function GET(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const { searchParams } = new URL(request.url);
  const namespace = searchParams.get('namespace') || 'zenos';
  const engine = getMemoryEngine();
  const memories = await engine.recall({ query: '', namespace, limit: 500, include_low_quality: true, include_secrets: true });
  const graph = buildTemporalGraph(memories);
  const readiness = productionReadiness(memories);
  const maintenance = buildMaintenanceReport(memories);

  return NextResponse.json({
    success: true,
    namespace,
    dashboard: {
      memory_count: memories.length,
      by_type: memories.reduce((acc: Record<string, number>, m) => { acc[m.type] = (acc[m.type] || 0) + 1; return acc; }, {}),
      readiness,
      graph: graph.stats,
      maintenance: maintenance.totals,
      top_entities: graph.nodes.slice(0, 12).map(n => ({ label: n.label, type: n.type, weight: n.weight })),
      recommendations: maintenance.recommendations,
    },
  });
}
