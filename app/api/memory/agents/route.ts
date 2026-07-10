import { NextRequest } from 'next/server';
import { z } from 'zod';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { errorResponse, requestId } from '../../../lib/errors';
import { jsonResponse } from '../../../lib/http';
import { getMemoryEngine } from '../../../lib/memory-engine';

const AgentSchema = z.object({
  agentId: z.string().trim().min(1).max(96).regex(/^[a-zA-Z0-9._:-]+$/),
  name: z.string().trim().min(1).max(256),
  config: z.record(z.string(), z.unknown()).optional().default({}),
});

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    const agents = await getMemoryEngine().listAgents();
    return jsonResponse({ success: true, agents, request_id: id }, { requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    const parsed = AgentSchema.parse(await request.json());
    const agent = await getMemoryEngine().createAgent(parsed.agentId, parsed.name, parsed.config);
    return jsonResponse({ success: true, agent, request_id: id }, { status: 201, requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
