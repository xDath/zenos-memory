import { NextRequest, NextResponse } from 'next/server';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';
import { getMemoryEngine } from '../../../lib/memory-engine';

export async function GET(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();

  const { searchParams } = new URL(request.url);
  const namespace = searchParams.get('namespace') || 'zenos';

  try {
    const engine = getMemoryEngine();
    const memories = await engine.recall({ query: '', namespace, limit: 50, type: 'insight' });

    // Basic temporal graph from blocks
    const nodes: any[] = [];
    const edges: any[] = [];
    const seen = new Set();

    for (const m of memories) {
      const blocks = m.metadata?.blocks || {};
      const entities = blocks.entities || blocks.key_decisions || [];
      for (const e of entities.slice(0, 5)) {
        const id = String(e).slice(0, 50);
        if (!seen.has(id)) {
          seen.add(id);
          nodes.push({ id, label: e, type: 'entity' });
        }
      }
      // Simple edges from timeline or decisions
      if (blocks.timeline) {
        for (let i = 0; i < blocks.timeline.length - 1; i++) {
          edges.push({ source: blocks.timeline[i], target: blocks.timeline[i+1], type: 'temporal' });
        }
      }
    }

    return NextResponse.json({
      success: true,
      graph: { nodes: nodes.slice(0, 20), edges: edges.slice(0, 30) },
      namespace,
    });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message });
  }
}
