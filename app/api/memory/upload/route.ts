import { NextRequest } from 'next/server';
import { z } from 'zod';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { errorResponse, requestId } from '../../../lib/errors';
import { jsonResponse } from '../../../lib/http';
import { getMemoryEngine } from '../../../lib/memory-engine';

const UploadSchema = z.object({
  content: z.string().min(1).max(112_000),
  filename: z.string().trim().min(1).max(256),
  namespace: z.string().trim().min(1).max(96).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/).optional(),
  agentId: z.string().trim().min(1).max(96).regex(/^[a-zA-Z0-9._:-]+$/).optional(),
});

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    const parsed = UploadSchema.parse(await request.json());
    const result = await getMemoryEngine().indexFile(
      parsed.content,
      parsed.filename,
      parsed.namespace || process.env.ZENOS_MEMORY_DEFAULT_NAMESPACE || 'zenos',
      parsed.agentId,
    );
    return jsonResponse({ success: true, result, request_id: id }, { status: 201, requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
