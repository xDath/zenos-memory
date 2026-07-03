import { NextRequest, NextResponse } from 'next/server';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  try {
    const { id, namespace } = await request.json();
    const engine = getMemoryEngine();
    const updated = await engine.enhanceMemoryWithAutoTags(id, namespace);
    return NextResponse.json({ success: !!updated, memory: updated });
  } catch (e: any) { return NextResponse.json({ error: e.message }, { status: 500 }); }
}
