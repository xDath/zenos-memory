import { NextRequest, NextResponse } from 'next/server';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  try {
    const { id1, id2, namespace } = await request.json();
    const engine = getMemoryEngine();
    const resolution = await engine.resolveConflict(id1, id2, namespace);
    return NextResponse.json({ success: true, resolution });
  } catch (e: any) { return NextResponse.json({ error: e.message }, { status: 500 }); }
}
