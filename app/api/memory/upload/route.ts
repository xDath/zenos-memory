import { NextRequest, NextResponse } from 'next/server';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const { content, filename, namespace = "default", agentId } = await request.json();
  const engine = getMemoryEngine();
  const result = await engine.indexFile(content, filename, namespace, agentId);
  return NextResponse.json({ success: true, result });
}
