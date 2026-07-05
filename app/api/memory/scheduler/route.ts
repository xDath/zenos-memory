import { NextRequest, NextResponse } from 'next/server';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { buildMaintenanceReport } from '../../../lib/memory-maintainer';

function validateScheduler(request: NextRequest) {
  if (validateApiKey(request)) return true;
  const cronSecret = process.env.CRON_SECRET;
  const auth = request.headers.get('authorization') || '';
  return !!cronSecret && auth === `Bearer ${cronSecret}`;
}

async function runScheduler(namespace = 'zenos') {
  const engine = getMemoryEngine();
  const memories = await engine.recall({ query: '', namespace, limit: 500, include_low_quality: true, include_secrets: true });
  const report = buildMaintenanceReport(memories);

  const stored = await engine.remember({
    content: JSON.stringify({ kind: 'scheduled-maintenance', namespace, report }, null, 2),
    type: 'insight',
    namespace,
    metadata: {
      source: 'zenos-scheduler',
      confidence: 0.95,
      importance: 8,
      tags: ['scheduler', 'maintenance', 'elite-polish'],
    },
  });

  return { report, stored };
}

export async function POST(request: NextRequest) {
  if (!validateScheduler(request)) return unauthorizedResponse();
  const body = await request.json().catch(() => ({}));
  const namespace = body.namespace || 'zenos';
  const result = await runScheduler(namespace);
  return NextResponse.json({ success: true, namespace, result });
}

export async function GET(request: NextRequest) {
  if (!validateScheduler(request)) return unauthorizedResponse();
  const { searchParams } = new URL(request.url);
  const namespace = searchParams.get('namespace') || 'zenos';
  const result = await runScheduler(namespace);
  return NextResponse.json({ success: true, namespace, result });
}
