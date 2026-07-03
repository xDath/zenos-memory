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

    const engine = getMemoryEngine();
    const stats = await engine.getStats(namespace);

    return NextResponse.json({
      success: true,
      stats,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
