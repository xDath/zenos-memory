import { NextRequest } from 'next/server';
import { z } from 'zod';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { errorResponse, requestId } from '../../../lib/errors';
import { getMemoryEngine } from '../../../lib/memory-engine';

const FormatSchema = z.enum(['json', 'csv']);

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    const url = new URL(request.url);
    const namespace = url.searchParams.get('namespace');
    const format = FormatSchema.parse(url.searchParams.get('format') || 'json');
    const exported = await getMemoryEngine().exportMemories(namespace, format);
    if (format === 'csv') {
      return new Response(String(exported.data), {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="zenos-memory-${namespace || 'all'}.csv"`,
          'cache-control': 'no-store',
          'x-request-id': id,
        },
      });
    }
    return Response.json({ success: true, exported, request_id: id }, {
      headers: { 'cache-control': 'no-store', 'x-request-id': id },
    });
  } catch (error) {
    return errorResponse(error, id);
  }
}
