import { NextRequest, NextResponse } from 'next/server';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';

export async function GET(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();

  const { searchParams } = new URL(request.url);
  const namespace = searchParams.get('namespace') || 'zenos';
  const limit = Math.min(500, Math.max(1, Number(searchParams.get('limit') || 200)));
  const entity = searchParams.get('entity')?.toLowerCase();

  const engine = getMemoryEngine();
  const memories = await engine.list(namespace, limit);
  const filtered = entity
    ? memories.filter(memory =>
        memory.content.toLowerCase().includes(entity) ||
        memory.metadata.entities.some(item => item.toLowerCase().includes(entity)) ||
        memory.metadata.tags.some(item => item.toLowerCase().includes(entity))
      )
    : memories;

  const events = filtered
    .map(memory => ({
      id: memory.id,
      type: memory.type,
      content: memory.metadata.is_secret ? '[redacted secret]' : memory.content.slice(0, 500),
      created_at: memory.created_at,
      updated_at: memory.updated_at,
      valid_from: memory.metadata.provenance?.valid_from || memory.created_at,
      valid_to: memory.metadata.provenance?.valid_to,
      supersedes_ids: memory.metadata.supersedes_ids,
      contradictions: memory.metadata.contradictions,
      source: memory.metadata.source,
      provenance: memory.metadata.provenance,
      current: !memory.metadata.provenance?.valid_to && !memory.metadata.tags.includes('superseded'),
    }))
    .sort((a, b) => new Date(a.valid_from).getTime() - new Date(b.valid_from).getTime());

  return NextResponse.json({ success: true, namespace, entity: entity || null, count: events.length, events });
}
