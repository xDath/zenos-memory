import { NextRequest } from 'next/server';
import { z } from 'zod';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { errorResponse, requestId } from '../../../lib/errors';
import { enforceRateLimit, jsonResponse } from '../../../lib/http';
import { getMemoryEngine } from '../../../lib/memory-engine';

const BackupSchema = z.object({ namespace: z.string().optional() });

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    enforceRateLimit(request, { bucket: 'backup', limit: 5, windowMs: 60_000 });
    const body = await request.json().catch(() => ({}));
    const parsed = BackupSchema.parse(body);
    const result = await getMemoryEngine().backupMemories(parsed.namespace);
    return jsonResponse({ success: true, backup: result, request_id: id }, { status: 201, requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
