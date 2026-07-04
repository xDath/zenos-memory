import { NextRequest, NextResponse } from 'next/server';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';

export async function GET(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();

  const { searchParams } = new URL(request.url);
  const namespace = searchParams.get('namespace') || 'zenos';
  const limit = Number(searchParams.get('limit') || 12);

  try {
    const engine = getMemoryEngine();
    const report = await engine.dailyIntelligenceReport(namespace);
    const recent = await engine.list(namespace, Math.min(Math.max(limit, 1), 50));
    const stats = await engine.getStats(namespace);
    const graph = await engine.getRelationshipGraph(namespace);

    const preferences = recent.filter(m => m.type === 'preference').slice(0, 8);
    const projects = recent.filter(m => m.type === 'project').slice(0, 8);
    const insights = await engine.generateInsights(namespace);

    return NextResponse.json({
      success: true,
      namespace,
      profile: {
        summary: report.summary,
        stats,
        health: report.health,
        insights: report.insights,
        generated_insights: insights.insights,
        preferences,
        projects,
        recent,
        graph_summary: {
          nodes: graph.nodes.length,
          edges: graph.edges.length,
          totalConnections: graph.totalConnections,
        },
      },
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
