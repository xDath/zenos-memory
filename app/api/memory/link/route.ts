import { NextRequest, NextResponse } from 'next/server';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  try {
    const { id1, id2, relation, namespace } = await request.json();
    const engine = getMemoryEngine();
    const success = await engine.linkMemories(id1, id2, relation, namespace);
    return NextResponse.json({ success });
  } catch (e: any) { return NextResponse.json({ error: e.message }, { status: 500 }); }
}
