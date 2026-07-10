import { NextRequest } from 'next/server';
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
    const limit = parsePositiveInteger(url.searchParams.get('limit'), 20, 100);
    const engine = getMemoryEngine();
    const [report, recent, stats, graph, generated] = await Promise.all([
      engine.dailyIntelligenceReport(namespace),
      engine.list(namespace, limit),
      engine.getStats(namespace),
      engine.getRelationshipGraph(namespace),
      engine.generateInsights(namespace),
    ]);
    return jsonResponse({
      success: true,
      namespace,
      profile: {
        summary: report.summary,
        stats,
        health: report.health,
        insights: [...report.insights, ...generated.insights],
        preferences: recent.filter(memory => memory.type === 'preference').slice(0, 12),
        projects: recent.filter(memory => memory.type === 'project').slice(0, 12),
        recent,
        graph_summary: {
          nodes: graph.nodes.length,
          edges: graph.edges.length,
          explicit_connections: graph.totalConnections,
        },
      },
      request_id: id,
    }, { requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
