import { Memory } from './schema';

type Episode = {
  id: string;
  title: string;
  start: string;
  end: string;
  memory_ids: string[];
  entities: string[];
  summary: string;
  provenance_sources: string[];
};

function dayKey(date: string): string {
  return new Date(date).toISOString().slice(0, 10);
}

function titleFor(memories: Memory[]): string {
  const tags = new Map<string, number>();
  for (const memory of memories) for (const tag of memory.metadata.tags || []) tags.set(tag, (tags.get(tag) || 0) + 1);
  const top = [...tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([tag]) => tag);
  return top.length ? top.join(' / ') : memories[0]?.type || 'memory episode';
}

export function buildEpisodes(memories: Memory[], limit = 20): Episode[] {
  const groups = new Map<string, Memory[]>();
  for (const memory of memories) {
    const key = `${dayKey(memory.created_at)}:${(memory.metadata.tags || [memory.type])[0] || memory.type}`;
    groups.set(key, [...(groups.get(key) || []), memory]);
  }

  return [...groups.entries()]
    .map(([key, items]) => {
      const sorted = [...items].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      const entities = [...new Set(sorted.flatMap(memory => memory.metadata.entities || []))].slice(0, 20);
      const sources = [...new Set(sorted.map(memory => memory.metadata.provenance?.source_id || memory.metadata.source || '').filter(Boolean))].slice(0, 20);
      return {
        id: `episode:${key}`,
        title: titleFor(sorted),
        start: sorted[0].created_at,
        end: sorted[sorted.length - 1].updated_at,
        memory_ids: sorted.map(memory => memory.id),
        entities,
        summary: sorted.map(memory => memory.metadata.is_secret ? '[redacted secret]' : memory.content.slice(0, 180)).join('\n---\n').slice(0, 1200),
        provenance_sources: sources,
      };
    })
    .sort((a, b) => new Date(b.end).getTime() - new Date(a.end).getTime())
    .slice(0, limit);
}
