import { NextRequest, NextResponse } from 'next/server';
import { RecallRequestSchema } from '../../../lib/schema';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';
import { rateLimit } from '../../../lib/rate-limit';

export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for') || 'unknown';
  if (!rateLimit(ip)) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  if (!validateApiKey(request)) {
    return unauthorizedResponse();
  }

  try {
    const body = await request.json();
    const parsed = RecallRequestSchema.parse(body);

    const engine = getMemoryEngine();
    const results = await engine.recall(parsed);

    return NextResponse.json({
      success: true,
      count: results.length,
      results,
      query: parsed.query,
    });

  } catch (error: any) {
    console.error('Recall error:', error);
    if (error.name === 'ZodError') {
      return NextResponse.json({ error: 'Validation error', details: error.errors }, { status: 400 });
    }
    return NextResponse.json({ error: 'Failed to recall', details: error.message }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('query') || 'test';
  const namespace = searchParams.get('namespace') || 'default';
  const limit = parseInt(searchParams.get('limit') || '5');

  try {
    const engine = getMemoryEngine();
    const results = await engine.recall({ query, namespace, limit });

    return NextResponse.json({
      success: true,
      count: results.length,
      results,
      note: 'Use POST with body for full options. This GET is for quick testing.'
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
