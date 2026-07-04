import { NextRequest, NextResponse } from 'next/server';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';
import { rateLimit } from '../../../lib/rate-limit';
import { CompactRequestSchema, buildCompactSnapshot, buildAdvancedCompactSnapshot, buildDagCompactSnapshot } from '../../../lib/compaction';

export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for') || 'unknown';
  if (!rateLimit(ip)) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  if (!validateApiKey(request)) return unauthorizedResponse();

  try {
    const body = await request.json();
    const parsed = CompactRequestSchema.parse(body);
    const snapshot = parsed.mode === 'deterministic'
      ? buildCompactSnapshot(parsed)
      : parsed.mode === 'advanced'
        ? buildAdvancedCompactSnapshot(parsed)
        : buildDagCompactSnapshot(parsed);
    const engine = getMemoryEngine();
    const memory = await engine.remember({
      content: snapshot.content,
      type: snapshot.type,
      namespace: parsed.namespace,
      metadata: snapshot.metadata as any,
    });

    return NextResponse.json({
      success: true,
      memory,
      compact: {
        content: snapshot.content,
        strategy: snapshot.metadata.compact_strategy,
        mode: parsed.mode,
        chars: snapshot.content.length,
        blocks: 'blocks' in snapshot ? snapshot.blocks : undefined,
      },
    });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return NextResponse.json({ error: 'Validation error', details: error.errors }, { status: 400 });
    }
    return NextResponse.json({ error: 'Failed to compact', details: error.message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    success: true,
    endpoint: '/api/memory/compact',
    default_mode: 'dag',
    strategies: [
      'topic-aware-compaction-dag-working-pack-v3',
      'advanced-structured-memory-blocks-v2',
      'deterministic-tail-handoff-v1',
    ],
  });
}
