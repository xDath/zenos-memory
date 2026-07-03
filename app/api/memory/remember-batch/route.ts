import { NextRequest, NextResponse } from 'next/server';
import { RememberRequestSchema } from '../../../lib/schema';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) {
    return unauthorizedResponse();
  }

  try {
    const body = await request.json();
    const requests = Array.isArray(body) ? body : body.requests;

    if (!Array.isArray(requests) || requests.length === 0) {
      return NextResponse.json({ error: 'Array of remember requests required' }, { status: 400 });
    }

    const parsed = requests.map(r => RememberRequestSchema.parse(r));

    const engine = getMemoryEngine();
    const memories = await engine.rememberBatch(parsed);

    return NextResponse.json({
      success: true,
      count: memories.length,
      memories,
    }, { status: 201 });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
