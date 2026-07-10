import { createHash } from 'node:crypto';
import { RememberRequest } from './schema';

type Chunk = {
  index: number;
  content: string;
  heading?: string;
  tokens: string[];
};

type EntityLink = {
  entity: string;
  chunk_indexes: number[];
  count: number;
};

type Relationship = {
  source: string;
  target: string;
  relation: 'co_occurs' | 'defines' | 'mentions';
  chunk_index: number;
  evidence: string;
};

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'you', 'are', 'was', 'were',
  'yang', 'dan', 'atau', 'dengan', 'untuk', 'dari', 'ini', 'itu', 'jadi', 'kalau', 'karena',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length > 2 && !STOP_WORDS.has(t));
}

function extractEntities(text: string): string[] {
  const values = new Set<string>();
  const proper = text.match(/\b[A-Z][A-Za-z0-9_.-]{2,}\b/g) || [];
  const services = text.match(/\b(zenos memory|google drive|github|vercel|hermes|etla|oauth|hmac|mem0|graphiti|zep|cognee|shodh|openclaw|api|sdk|cli)\b/gi) || [];
  for (const item of [...proper, ...services]) values.add(item.trim());
  return [...values].slice(0, 18);
}

function detectHeading(block: string): string | undefined {
  const first = block.split('\n').map(line => line.trim()).find(Boolean) || '';
  if (/^#{1,6}\s+/.test(first)) return first.replace(/^#{1,6}\s+/, '').slice(0, 120);
  if (first.length <= 90 && /[:：]$/.test(first)) return first.replace(/[:：]$/, '');
  return undefined;
}

export function chunkDocument(content: string, maxChars = 1400): Chunk[] {
  const blocks = content
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map(block => block.trim())
    .filter(Boolean);

  const chunks: Chunk[] = [];
  let current = '';
  let heading: string | undefined;

  function flush() {
    const text = current.trim();
    if (!text) return;
    chunks.push({ index: chunks.length, content: text, heading, tokens: tokenize(text) });
    current = '';
    heading = undefined;
  }

  for (const block of blocks) {
    const blockHeading = detectHeading(block);
    if (block.length > maxChars) {
      flush();
      for (let offset = 0; offset < block.length; offset += maxChars) {
        const part = block.slice(offset, offset + maxChars).trim();
        if (!part) continue;
        chunks.push({
          index: chunks.length,
          content: part,
          heading: offset === 0 ? blockHeading : undefined,
          tokens: tokenize(part),
        });
      }
      continue;
    }
    if ((current.length + block.length + 2) > maxChars) flush();
    if (!current && blockHeading) heading = blockHeading;
    current = current ? `${current}\n\n${block}` : block;
  }
  flush();

  return chunks.length ? chunks : [{ index: 0, content: content.slice(0, maxChars), tokens: tokenize(content) }];
}

export function extractEntityLinks(chunks: Chunk[]): EntityLink[] {
  const map = new Map<string, { chunk_indexes: Set<number>; count: number; label: string }>();
  for (const chunk of chunks) {
    for (const entity of extractEntities(chunk.content)) {
      const key = entity.toLowerCase();
      const entry = map.get(key) || { chunk_indexes: new Set<number>(), count: 0, label: entity };
      entry.chunk_indexes.add(chunk.index);
      entry.count += 1;
      map.set(key, entry);
    }
  }
  return [...map.values()]
    .map(entry => ({ entity: entry.label, chunk_indexes: [...entry.chunk_indexes], count: entry.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 80);
}

export function extractRelationships(chunks: Chunk[]): Relationship[] {
  const relationships: Relationship[] = [];
  for (const chunk of chunks) {
    const entities = extractEntities(chunk.content).slice(0, 8);
    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        relationships.push({
          source: entities[i],
          target: entities[j],
          relation: 'co_occurs',
          chunk_index: chunk.index,
          evidence: chunk.content.slice(0, 240),
        });
      }
    }
    const defineMatch = chunk.content.match(/\b([A-Z][A-Za-z0-9_.-]{2,})\s+(?:is|adalah|means|berarti)\s+([^.!?]{8,160})/);
    if (defineMatch) {
      relationships.push({
        source: defineMatch[1],
        target: defineMatch[2].trim(),
        relation: 'defines',
        chunk_index: chunk.index,
        evidence: defineMatch[0],
      });
    }
  }
  return relationships.slice(0, 120);
}

export function buildKnowledgeMemories(content: string, filename: string, namespace = 'default', agentId?: string): RememberRequest[] {
  const chunks = chunkDocument(content);
  const entityLinks = extractEntityLinks(chunks);
  const relationships = extractRelationships(chunks);
  const sourceHash = createHash('sha256').update(content).digest('hex');
  const docId = `${filename}:${sourceHash.slice(0, 24)}`;
  const idempotencyKey = (kind: string) => createHash('sha256')
    .update(`ingest:${namespace}:${docId}:${kind}`)
    .digest('hex');

  const memories: RememberRequest[] = chunks.slice(0, 80).map(chunk => ({
    content: chunk.content,
    idempotency_key: idempotencyKey(`chunk:${chunk.index}`),
    type: 'file',
    namespace,
    metadata: {
      source: `file:${filename}`,
      provenance: {
        created_by: agentId || 'knowledge-ingestion',
        source_id: docId,
        source_hash: sourceHash,
        chunk_index: chunk.index,
        heading: chunk.heading,
      },
      tags: ['file', filename.split('.').pop() || 'document', 'knowledge-chunk'],
      entities: extractEntities(chunk.content),
      importance: chunk.heading ? 7 : 6,
      confidence: 0.82,
    },
  }));

  if (entityLinks.length) {
    memories.push({
      content: JSON.stringify({ filename, entity_links: entityLinks.slice(0, 40) }),
      idempotency_key: idempotencyKey('entity-index'),
      type: 'insight',
      namespace,
      metadata: {
        source: `file:${filename}:entity-index`,
        provenance: {
          created_by: agentId || 'knowledge-ingestion',
          source_id: docId,
          source_hash: sourceHash,
        },
        tags: ['knowledge-index', 'entity-index', filename],
        entities: entityLinks.slice(0, 20).map(link => link.entity),
        importance: 8,
        confidence: 0.84,
      },
    });
  }

  if (relationships.length) {
    memories.push({
      content: JSON.stringify({ filename, relationships: relationships.slice(0, 60) }),
      idempotency_key: idempotencyKey('relationship-index'),
      type: 'relationship',
      namespace,
      metadata: {
        source: `file:${filename}:relationship-index`,
        provenance: {
          created_by: agentId || 'knowledge-ingestion',
          source_id: docId,
          source_hash: sourceHash,
        },
        tags: ['knowledge-graph', 'relationship-index', filename],
        entities: [...new Set(relationships.flatMap(rel => [rel.source, rel.target]))].slice(0, 30),
        importance: 8,
        confidence: 0.78,
      },
    });
  }

  return memories;
}
