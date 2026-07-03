import { NextRequest, NextResponse } from 'next/server';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';

export async function GET(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const { searchParams } = new URL(request.url);
  const namespace = searchParams.get('namespace') || 'default';
  const engine = getMemoryEngine();
  const graph = await engine.getRelationshipGraph(namespace);
  return NextResponse.json({ success: true, graph });
}
