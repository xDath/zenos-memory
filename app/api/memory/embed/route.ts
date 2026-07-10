import { NextRequest } from 'next/server';
import { z } from 'zod';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { errorResponse, requestId } from '../../../lib/errors';
import { jsonResponse } from '../../../lib/http';
import { getEmbedding } from '../../../lib/neural-embedding';

const EmbedSchema = z.object({
  text: z.string().trim().min(1).max(8000).optional(),
  query: z.string().trim().min(1).max(8000).optional(),
  include_vector: z.boolean().optional().default(false),
}).refine(value => Boolean(value.text || value.query), {
  message: 'text or query is required',
  path: ['text'],
});

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    const parsed = EmbedSchema.parse(await request.json());
    const embedding = await getEmbedding(parsed.text || parsed.query || '');
    return jsonResponse({
      success: true,
      dimensions: embedding.vector.length,
      provider: embedding.provider,
      ok: embedding.ok,
      error: embedding.error,
      vector: parsed.include_vector ? embedding.vector : undefined,
      request_id: id,
    }, { requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
