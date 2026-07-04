import { NextRequest, NextResponse } from 'next/server';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { buildMaintenanceReport } from '../../../lib/memory-maintainer';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  try {
    const body = await request.json().catch(() => ({}));
    const namespace = body.namespace || 'zenos';
    const engine = getMemoryEngine();
    const memories = await engine.recall({ query: '', namespace, limit: 500, include_low_quality: true, include_secrets: true });
    const report = buildMaintenanceReport(memories);

    if (body.store !== false) {
      await engine.remember({
        content: JSON.stringify(report, null, 2),
        type: 'insight',
        namespace,
        metadata: {
          source: 'zenos-maintainer',
          confidence: 0.95,
          importance: 8,
          tags: ['maintenance', 'dedup', 'graph', 'health'],
        },
      });
    }

    return NextResponse.json({ success: true, namespace, report });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message || String(error) }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const { searchParams } = new URL(request.url);
  const namespace = searchParams.get('namespace') || 'zenos';
  const engine = getMemoryEngine();
  const memories = await engine.recall({ query: '', namespace, limit: 500, include_low_quality: true, include_secrets: true });
  return NextResponse.json({ success: true, namespace, report: buildMaintenanceReport(memories) });
}
