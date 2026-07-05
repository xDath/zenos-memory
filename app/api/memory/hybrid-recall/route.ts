import { NextRequest, NextResponse } from 'next/server';
import { RecallRequestSchema } from '../../../lib/schema';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';
import { rateLimit } from '../../../lib/rate-limit';

export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for') || 'unknown';
  if (!rateLimit(ip)) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  if (!validateApiKey(request)) return unauthorizedResponse();

  try {
    const parsed = RecallRequestSchema.parse(await request.json());
    const engine = getMemoryEngine();
    const results = await engine.recallWithQuality(parsed);
    return NextResponse.json({
      success: true,
      mode: 'hybrid-recall-v2',
      query: parsed.query,
      count: results.length,
      results,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to run hybrid recall';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
