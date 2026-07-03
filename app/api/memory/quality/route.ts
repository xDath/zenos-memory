import { NextRequest, NextResponse } from 'next/server';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';

export async function GET(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  const namespace = searchParams.get('namespace') || undefined;
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const engine = getMemoryEngine();
  const mems = await engine.recall({ query: '', namespace, limit: 100 });
  const mem = mems.find(m => m.id === id);
  if (!mem) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ success: true, quality: engine.computeQualityScore(mem), memory: mem });
}
