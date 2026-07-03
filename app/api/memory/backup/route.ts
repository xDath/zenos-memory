import { NextRequest, NextResponse } from 'next/server';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const { targetNamespace = "backup" } = await request.json();
  const engine = getMemoryEngine();
  const result = await engine.backupMemories(targetNamespace);
  return NextResponse.json({ success: true, result });
}
