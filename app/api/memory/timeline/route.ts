import { NextRequest } from 'next/server';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { errorResponse, requestId } from '../../../lib/errors';
import { jsonResponse, parsePositiveInteger } from '../../../lib/http';
import { getMemoryEngine } from '../../../lib/memory-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    const url = new URL(request.url);
    const namespace = url.searchParams.get('namespace') || 'zenos';
    const limit = parsePositiveInteger(url.searchParams.get('limit'), 200, 2000);
    const entity = url.searchParams.get('entity')?.trim().toLowerCase() || null;
    const memories = await getMemoryEngine().list(namespace, limit);
    const filtered = entity
      ? memories.filter(memory =>
          memory.content.toLowerCase().includes(entity)
          || memory.metadata.entities.some(item => item.toLowerCase().includes(entity))
          || memory.metadata.tags.some(item => item.toLowerCase().includes(entity)))
      : memories;
    const events = filtered
      .map(memory => ({
        id: memory.id,
        type: memory.type,
        content: memory.content.slice(0, 500),
        created_at: memory.created_at,
        updated_at: memory.updated_at,
        valid_from: memory.metadata.provenance?.valid_from || memory.created_at,
        valid_to: memory.metadata.provenance?.valid_to || null,
        status: memory.metadata.status,
        supersedes_ids: memory.metadata.supersedes_ids,
        contradictions: memory.metadata.contradictions,
        source: memory.metadata.source || null,
        provenance: memory.metadata.provenance || null,
        current: memory.metadata.status === 'active' && !memory.metadata.provenance?.valid_to,
      }))
      .sort((left, right) => left.valid_from.localeCompare(right.valid_from));
    return jsonResponse({
      success: true,
      namespace,
      entity,
      count: events.length,
      events,
      request_id: id,
    }, { requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
