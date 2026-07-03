import { NextRequest, NextResponse } from 'next/server';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';

export async function GET(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const engine = getMemoryEngine();
  const agents = await engine.listAgents();
  return NextResponse.json({ success: true, agents });
}

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const { agentId, name, config } = await request.json();
  const engine = getMemoryEngine();
  const agent = await engine.createAgent(agentId, name, config);
  return NextResponse.json({ success: true, agent });
}
