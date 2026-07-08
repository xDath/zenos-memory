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

export async function GET() {
  return NextResponse.json({
    error: 'Unauthorized',
    message: 'GET recall is disabled. Use signed POST /api/memory/recall.',
  }, { status: 401 });
}
