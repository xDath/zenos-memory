import { NextRequest, NextResponse } from 'next/server';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';

export async function GET(request: NextRequest) {
  if (!validateApiKey(request)) {
    return unauthorizedResponse();
  }

  try {
    const { searchParams } = new URL(request.url);
    const namespace = searchParams.get('namespace') || undefined;
    const limit = parseInt(searchParams.get('limit') || '20');

    const engine = getMemoryEngine();
    const memories = await engine.list(namespace, limit);

    return NextResponse.json({
      success: true,
      count: memories.length,
      memories,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
