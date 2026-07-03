import { NextRequest, NextResponse } from 'next/server';
import { RememberRequestSchema } from '../../../lib/schema';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';
import { rateLimit } from '../../../lib/rate-limit';

export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for') || 'unknown';
  if (!rateLimit(ip)) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }
  if (!validateApiKey(request)) {
    return unauthorizedResponse();
  }

  try {
    const body = await request.json();
    const parsed = RememberRequestSchema.parse(body);

    const engine = getMemoryEngine();
    const memory = await engine.remember(parsed);

    return NextResponse.json({
      success: true,
      memory,
      message: 'Memory stored successfully'
    }, { status: 201 });

  } catch (error: any) {
    console.error('Remember error:', error);
    if (error.name === 'ZodError') {
      return NextResponse.json({ error: 'Validation error', details: error.errors }, { status: 400 });
    }
    return NextResponse.json({ error: 'Failed to remember', details: error.message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    endpoint: '/api/memory/remember',
    method: 'POST',
    description: 'Store a new memory',
    example: {
      content: "User prefers dark mode UI",
      type: "preference",
      namespace: "zenos",
      metadata: { tags: ["ui", "preference"], confidence: 0.9 }
    }
  });
}
