import { NextRequest, NextResponse } from 'next/server';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  try {
    const body = await request.json();
    const { content, type = 'fact', namespace = 'default' } = body;
    const engine = getMemoryEngine();
    const tempMemory = { id: 'temp', content, type, namespace, metadata: { confidence: 0.8, tags: [], version: 1, importance: 5, related_ids: [] }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } as any;
    const conflicts = await engine.detectConflicts(tempMemory, namespace);
    return NextResponse.json({ success: true, conflicts, count: conflicts.length });
  } catch (e: any) { return NextResponse.json({ error: e.message }, { status: 500 }); }
}
