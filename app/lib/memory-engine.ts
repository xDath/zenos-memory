import { v4 as uuidv4 } from 'uuid';
import { Memory, RememberRequest, RecallRequest, MemoryMetadataSchema } from './schema';
import { GoogleDriveMemoryStore, LocalFileMemoryStore, createDriveStore } from './drive';

type ScoredMemory = Memory & { quality?: number; score?: number; reason?: string };

type TokenVector = Map<string, number>;

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'to', 'of', 'in', 'on', 'for', 'with',
  'yang', 'dan', 'atau', 'ini', 'itu', 'buat', 'dari', 'ke', 'di', 'gue', 'lu', 'kan', 'jadi', 'aja', 'sama',
]);

export class MemoryEngine {
  private store: GoogleDriveMemoryStore | LocalFileMemoryStore;
  private useDrive: boolean;

  constructor() {
    // SECURITY NOTE: Never log or expose service account keys.
    // For Vercel: always use GOOGLE_SERVICE_ACCOUNT_KEY as JSON string env var.
    // For local: prefer GOOGLE_SERVICE_ACCOUNT_FILE pointing to secure location outside git.
    const hasDriveCreds = (!!process.env.GOOGLE_SERVICE_ACCOUNT_KEY || !!process.env.GOOGLE_SERVICE_ACCOUNT_FILE) && !!process.env.ZENOS_MEMORY_DRIVE_FOLDER_ID;

    if (hasDriveCreds && process.env.USE_LOCAL_STORE !== 'true') {
      try {
        this.store = createDriveStore();
        this.useDrive = true;
        console.log('[ZenosMemory] Using Google Drive storage');
      } catch (e) {
        console.warn('[ZenosMemory] Drive init failed, falling back to local:', e);
        this.store = new LocalFileMemoryStore();
        this.useDrive = false;
      }
    } else {
      this.store = new LocalFileMemoryStore();
      this.useDrive = false;
      console.log('[ZenosMemory] Using local file storage (dev mode)');
    }
  }

  private async loadMemories(namespace?: string): Promise<Memory[]> {
    const all = await this.store.readAll(namespace);
    const normalized = (Array.isArray(all) ? all : []).filter((m: any) => m && m.id && m.content);
    if (namespace) return normalized.filter((m: any) => m.namespace === namespace);
    return normalized;
  }

  private async saveMemories(memories: Memory[], namespace?: string): Promise<void> {
    await this.store.writeAll(memories, namespace || memories[0]?.namespace || 'zenos');
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .map(t => t.trim())
      .filter(t => t.length > 2 && !STOP_WORDS.has(t));
  }

  private vectorize(text: string): TokenVector {
    const vector = new Map<string, number>();
    for (const token of this.tokenize(text)) {
      vector.set(token, (vector.get(token) || 0) + 1);
    }
    return vector;
  }

  private cosineSimilarity(a: string, b: string): number {
    const va = this.vectorize(a);
    const vb = this.vectorize(b);
    if (va.size === 0 || vb.size === 0) return 0;

    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (const value of va.values()) normA += value * value;
    for (const value of vb.values()) normB += value * value;
    for (const [key, value] of va.entries()) dot += value * (vb.get(key) || 0);

    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private jaccardSimilarity(a: string, b: string): number {
    const sa = new Set(this.tokenize(a));
    const sb = new Set(this.tokenize(b));
    if (sa.size === 0 || sb.size === 0) return 0;
    const intersection = [...sa].filter(x => sb.has(x)).length;
    const union = new Set([...sa, ...sb]).size;
    return intersection / union;
  }

  private textSimilarity(a: string, b: string): number {
    return (this.cosineSimilarity(a, b) * 0.65) + (this.jaccardSimilarity(a, b) * 0.35);
  }

  private normalizeTags(tags?: string[]): string[] {
    return [...new Set((tags || []).map(t => t.toLowerCase().trim()).filter(Boolean))];
  }

  private inferType(content: string): Memory['type'] {
    const lower = content.toLowerCase();
    if (/\b(prefer|like|love|hate|dislike|suka|gasuka|seneng|preferensi)\b/.test(lower)) return 'preference';
    if (/\b(project|repo|deploy|build|roadmap|phase|vercel|github)\b/.test(lower)) return 'project';
    if (/\b(todo|task|deadline|lanjut|kerjain|fix)\b/.test(lower)) return 'task';
    if (/\b(insight|conclusion|learned|pattern)\b/.test(lower)) return 'insight';
    return 'fact';
  }

  async autoTag(content: string): Promise<string[]> {
    const lower = content.toLowerCase();
    const tags = new Set<string>();
    const keywords = [
      'preference', 'project', 'memory', 'drive', 'google', 'vercel', 'github', 'agent', 'etla', 'zenos',
      'fragrance', 'vanilla', 'amber', 'auth', 'security', 'roadmap', 'phase', 'deploy', 'api', 'backup',
    ];

    for (const kw of keywords) if (lower.includes(kw)) tags.add(kw);
    if (content.length > 120) tags.add('detailed');
    if (/\d+/.test(content)) tags.add('numeric');
    if (/\b(always|never|selalu|jangan)\b/.test(lower)) tags.add('strong-signal');
    return [...tags];
  }

  private extractEntities(content: string): string[] {
    const candidates = content.match(/\b[A-Z][a-zA-Z0-9_-]{2,}\b/g) || [];
    const domain = this.tokenize(content).filter(t => ['zenos', 'etla', 'vercel', 'github', 'drive', 'memory', 'mem0', 'memanto'].includes(t));
    return [...new Set([...candidates, ...domain])].slice(0, 12);
  }

  private extractFacts(content: string): RememberRequest[] {
    const pieces = content
      .split(/\n+|(?<=[.!?])\s+/)
      .map(p => p.trim())
      .filter(p => p.length > 12)
      .slice(0, 8);

    return pieces.map(piece => ({
      content: piece,
      type: this.inferType(piece),
      metadata: {
        confidence: /\b(always|never|must|harus|jangan|prefer|suka|hate|love)\b/i.test(piece) ? 0.88 : 0.72,
        importance: /\b(project|deploy|secret|auth|security|prefer|suka|jangan)\b/i.test(piece) ? 8 : 5,
        tags: [],
        entities: this.extractEntities(piece),
      },
    }));
  }

  private async findDuplicate(content: string, namespace: string, memories: Memory[]): Promise<Memory | null> {
    let best: { memory: Memory; similarity: number } | null = null;
    for (const memory of memories.filter(m => m.namespace === namespace)) {
      const similarity = this.textSimilarity(content, memory.content);
      if (similarity >= 0.72 && (!best || similarity > best.similarity)) best = { memory, similarity };
    }
    return best?.memory || null;
  }

  async remember(req: RememberRequest): Promise<Memory> {
    const all = await this.store.readAll();
    const namespace = req.namespace || 'default';
    const duplicate = await this.findDuplicate(req.content, namespace, all as Memory[]);

    if (duplicate) {
      return (await this.edit(duplicate.id, {
        content: req.content.length > duplicate.content.length ? req.content : duplicate.content,
        metadata: {
          ...duplicate.metadata,
          ...req.metadata,
          confidence: Math.max(duplicate.metadata.confidence || 0.8, req.metadata?.confidence || 0.8),
          importance: Math.max(duplicate.metadata.importance || 5, req.metadata?.importance || 5),
          tags: this.normalizeTags([...(duplicate.metadata.tags || []), ...(req.metadata?.tags || []), ...(await this.autoTag(req.content))]),
        },
      }, namespace)) as Memory;
    }

    const now = new Date().toISOString();
    const metadata = MemoryMetadataSchema.parse({
      ...req.metadata,
      tags: this.normalizeTags([...(req.metadata?.tags || []), ...(await this.autoTag(req.content))]),
      entities: [...new Set([...(req.metadata?.entities || []), ...this.extractEntities(req.content)])],
      timestamp: now,
    });

    const newMemory: Memory = {
      id: uuidv4(),
      type: req.type || this.inferType(req.content),
      content: req.content,
      namespace,
      metadata,
      created_at: now,
      updated_at: now,
    };

    all.push(newMemory);
    await this.saveMemories(all as Memory[], newMemory.namespace);
    return newMemory;
  }

  async rememberBatch(requests: RememberRequest[]): Promise<Memory[]> {
    const results: Memory[] = [];
    for (const req of requests) results.push(await this.remember(req));
    return results;
  }

  async rememberFromConversation(conversation: Array<{ role: string; content: string }>, namespace = 'default', conversationId?: string): Promise<Memory[]> {
    const candidates: RememberRequest[] = [];
    for (const turn of conversation.filter(t => t.content && ['user', 'assistant'].includes(t.role))) {
      for (const fact of this.extractFacts(turn.content)) {
        candidates.push({
          ...fact,
          namespace,
          metadata: {
            ...fact.metadata,
            source: conversationId ? `conversation:${conversationId}` : 'conversation',
            provenance: { conversation_id: conversationId },
            importance: Math.max(fact.metadata?.importance || 5, turn.role === 'user' ? 7 : 5),
          },
        });
      }
    }
    return this.rememberBatch(candidates);
  }

  async recall(req: RecallRequest): Promise<Memory[]> {
    const scored = await this.recallWithQuality(req);
    return scored.map(({ quality, score, reason, ...memory }) => memory as Memory);
  }

  async recallWithQuality(req: RecallRequest): Promise<ScoredMemory[]> {
    let memories = await this.loadMemories(req.namespace);
    const query = req.query || '';
    const queryLower = query.toLowerCase();
    const queryTags = new Set(this.tokenize(query));

    if (req.type) memories = memories.filter(m => m.type === req.type);
    if (req.min_confidence) memories = memories.filter(m => (m.metadata.confidence || 0) >= req.min_confidence!);
    if (req.tags?.length) memories = memories.filter(m => req.tags!.some(tag => m.metadata.tags.includes(tag)));
    if (req.created_after) memories = memories.filter(m => new Date(m.created_at).getTime() >= new Date(req.created_after!).getTime());
    if (req.created_before) memories = memories.filter(m => new Date(m.created_at).getTime() <= new Date(req.created_before!).getTime());
    if (!req.include_secrets) {
      memories = memories.filter(m => !((m.metadata as any).is_secret));
    }

    const scored = memories.map(memory => {
      const quality = this.computeQualityScore(memory);
      const similarity = this.textSimilarity(query, `${memory.content} ${memory.metadata.tags.join(' ')}`);
      const exact = memory.content.toLowerCase().includes(queryLower) ? 1 : 0;
      const tagOverlap = memory.metadata.tags.filter(t => queryTags.has(t.toLowerCase())).length;
      const recency = this.recencyScore(memory);
      const importance = (memory.metadata.importance || 5) / 10;
      const score = (similarity * 45) + (exact * 20) + (tagOverlap * 8) + (quality * 20) + (recency * 5) + (importance * 5);
      const reason = exact ? 'exact-match' : similarity > 0.4 ? 'semantic-similarity' : tagOverlap ? 'tag-match' : 'quality-recency';
      return { ...memory, quality, score, reason };
    });

    const top = scored
      .filter(m => req.include_low_quality || m.score! > 0 || query.trim() === '')
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, req.limit || 10);

    // Lightweight usage tracking improves future quality scores without blocking recall on failures.
    void this.touchMemories(top.map(m => m.id), req.namespace).catch(() => undefined);
    return top;
  }

  private async touchMemories(ids: string[], namespace?: string): Promise<void> {
    if (!ids.length) return;
    const all = await this.store.readAll();
    const now = new Date().toISOString();
    let changed = false;
    for (const memory of all as Memory[]) {
      if (ids.includes(memory.id) && (!namespace || memory.namespace === namespace)) {
        memory.metadata.access_count = (memory.metadata.access_count || 0) + 1;
        memory.metadata.last_accessed_at = now;
        changed = true;
      }
    }
    if (changed) await this.saveMemories(all as Memory[], namespace);
  }

  private recencyScore(memory: Memory): number {
    const ageDays = (Date.now() - new Date(memory.created_at).getTime()) / (1000 * 3600 * 24);
    return Math.max(0, 1 - (ageDays / 30));
  }

  computeQualityScore(memory: Memory): number {
    const confidence = memory.metadata.confidence || 0.5;
    const importance = (memory.metadata.importance || 5) / 10;
    const recency = this.recencyScore(memory);
    const tagScore = Math.min((memory.metadata.tags?.length || 0) / 5, 1);
    const relationScore = Math.min((memory.metadata.related_ids?.length || 0) / 3, 1);
    const lengthScore = memory.content.length < 12 ? 0.2 : memory.content.length > 4000 ? 0.6 : 1;
    const accessScore = Math.min((memory.metadata.access_count || 0) / 10, 1);
    const quality = (confidence * 0.25) + (importance * 0.25) + (recency * 0.18) + (tagScore * 0.12) + (relationScore * 0.07) + (lengthScore * 0.08) + (accessScore * 0.05);
    return Math.min(Math.max(quality, 0), 1);
  }

  async detectConflicts(newMemory: Memory, namespace?: string): Promise<Memory[]> {
    const memories = await this.loadMemories(namespace || newMemory.namespace);
    const lower = newMemory.content.toLowerCase();
    const neg = /\b(not|never|hate|dislike|jangan|gasuka|tidak)\b/.test(lower);
    const pos = /\b(like|love|prefer|always|suka|senang|mau)\b/.test(lower);

    return memories.filter(memory => {
      if (memory.id === newMemory.id) return false;
      const similarity = this.textSimilarity(newMemory.content, memory.content);
      if (similarity < 0.12) return false;
      const existing = memory.content.toLowerCase();
      const existingNeg = /\b(not|never|hate|dislike|jangan|gasuka|tidak)\b/.test(existing);
      const existingPos = /\b(like|love|prefer|always|suka|senang|mau)\b/.test(existing);
      return (neg && existingPos) || (pos && existingNeg);
    });
  }

  async edit(id: string, updates: Partial<Memory>, namespace?: string): Promise<Memory | null> {
    const all = await this.store.readAll();
    const idx = (all as Memory[]).findIndex(m => m.id === id && (!namespace || m.namespace === namespace));
    if (idx === -1) return null;

    const current = all[idx] as Memory;
    const updated: Memory = {
      ...current,
      ...updates,
      metadata: {
        ...current.metadata,
        ...updates.metadata,
        version: (current.metadata.version || 1) + 1,
        tags: this.normalizeTags([...(current.metadata.tags || []), ...((updates.metadata as any)?.tags || [])]),
      },
      updated_at: new Date().toISOString(),
    };

    all[idx] = updated;
    await this.saveMemories(all as Memory[], updated.namespace);
    return updated;
  }

  async forget(id: string, namespace?: string): Promise<boolean> {
    const all = await this.store.readAll();
    const filtered = (all as Memory[]).filter(m => !(m.id === id && (!namespace || m.namespace === namespace)));
    if (filtered.length === all.length) return false;
    await this.saveMemories(filtered, namespace || all[0]?.namespace);
    return true;
  }

  async list(namespace?: string, limit = 20): Promise<Memory[]> {
    const all = await this.loadMemories(namespace);
    return all.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).slice(0, limit);
  }

  async getStats(namespace?: string) {
    const memories = await this.loadMemories(namespace);
    const byType: Record<string, number> = {};
    const avgQuality = memories.length ? memories.reduce((sum, m) => sum + this.computeQualityScore(m), 0) / memories.length : 0;
    memories.forEach(m => { byType[m.type] = (byType[m.type] || 0) + 1; });
    return { total: memories.length, byType, avgQuality, namespace: namespace || 'all', storage: this.useDrive ? 'google-drive' : 'local' };
  }

  async enhanceMemoryWithAutoTags(id: string, namespace?: string): Promise<Memory | null> {
    const all = await this.store.readAll();
    const idx = (all as Memory[]).findIndex(m => m.id === id && (!namespace || m.namespace === namespace));
    if (idx < 0) return null;
    const memory = all[idx] as Memory;
    memory.metadata.tags = this.normalizeTags([...(memory.metadata.tags || []), ...(await this.autoTag(memory.content))]);
    memory.updated_at = new Date().toISOString();
    await this.saveMemories(all as Memory[], memory.namespace);
    return memory;
  }

  async linkMemories(id1: string, id2: string, relation = 'related', namespace?: string): Promise<boolean> {
    const all = await this.store.readAll();
    const i1 = (all as Memory[]).findIndex(m => m.id === id1 && (!namespace || m.namespace === namespace));
    const i2 = (all as Memory[]).findIndex(m => m.id === id2 && (!namespace || m.namespace === namespace));
    if (i1 < 0 || i2 < 0) return false;
    const a = all[i1] as Memory;
    const b = all[i2] as Memory;
    if (!a.metadata.related_ids.includes(id2)) a.metadata.related_ids.push(id2);
    if (!b.metadata.related_ids.includes(id1)) b.metadata.related_ids.push(id1);
    a.updated_at = new Date().toISOString();
    b.updated_at = a.updated_at;
    await this.saveMemories(all as Memory[], namespace);
    return true;
  }

  async applyTemporalDecay(namespace?: string): Promise<number> {
    const all = await this.store.readAll();
    let updated = 0;
    for (const memory of all as Memory[]) {
      if (namespace && memory.namespace !== namespace) continue;
      const ageDays = (Date.now() - new Date(memory.created_at).getTime()) / (1000 * 3600 * 24);
      if (ageDays < 30) continue;
      const decay = Math.max(0.55, 1 - (ageDays / 365));
      memory.metadata.confidence = Math.max(0.1, (memory.metadata.confidence || 0.8) * decay);
      memory.updated_at = new Date().toISOString();
      updated++;
    }
    if (updated) await this.saveMemories(all as Memory[], updated.namespace);
    return updated;
  }

  async dailyIntelligenceReport(namespace = 'default') {
    const memories = await this.loadMemories(namespace);
    if (!memories.length) return { summary: 'No memories', insights: [], health: { total: 0, avgQuality: 0 } };

    const byType: Record<string, number> = {};
    const tagCounts: Record<string, number> = {};
    const entityCounts: Record<string, number> = {};
    memories.forEach(m => {
      byType[m.type] = (byType[m.type] || 0) + 1;
      m.metadata.tags.forEach(tag => { tagCounts[tag] = (tagCounts[tag] || 0) + 1; });
      (m.metadata.entities || []).forEach(entity => { entityCounts[entity] = (entityCounts[entity] || 0) + 1; });
    });
    const avgQuality = memories.reduce((s, m) => s + this.computeQualityScore(m), 0) / memories.length;
    const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([tag]) => tag);
    const topEntities = Object.entries(entityCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([entity]) => entity);
    const unhealthy = memories.filter(m => this.computeQualityScore(m) < 0.4).length;
    const insights = [
      `Top type: ${Object.entries(byType).sort((a, b) => b[1] - a[1])[0]?.[0] || 'none'}`,
      `Avg quality: ${avgQuality.toFixed(2)}`,
      ...(topTags.length ? [`Top tags: ${topTags.join(', ')}`] : []),
      ...(topEntities.length ? [`Top entities: ${topEntities.join(', ')}`] : []),
      ...(unhealthy ? [`${unhealthy} memories need review`] : ['Memory health looks good']),
    ];
    return { summary: `${memories.length} memories in ${namespace}, avg quality ${avgQuality.toFixed(2)}`, insights, health: { total: memories.length, avgQuality, unhealthy, byType, topTags, topEntities } };
  }

  async resolveConflict(id1: string, id2: string, namespace?: string) {
    const memories = await this.loadMemories(namespace);
    const m1 = memories.find(m => m.id === id1);
    const m2 = memories.find(m => m.id === id2);
    if (!m1 || !m2) return { suggestion: 'not found' };
    const q1 = this.computeQualityScore(m1);
    const q2 = this.computeQualityScore(m2);
    const newer = new Date(m1.updated_at) >= new Date(m2.updated_at) ? m1 : m2;
    const winner = Math.abs(q1 - q2) > 0.08 ? (q1 > q2 ? m1 : m2) : newer;
    return { suggestion: `prefer ${winner.id}`, winner, scores: { [m1.id]: q1, [m2.id]: q2 } };
  }

  async getRelationshipGraph(namespace = 'default') {
    const memories = await this.loadMemories(namespace);
    const nodes = memories.map(m => ({ id: m.id, label: m.content.slice(0, 80), type: m.type, quality: this.computeQualityScore(m), tags: m.metadata.tags }));
    const edges: Array<{ from: string; to: string; type: string; weight?: number }> = [];
    memories.forEach(m => (m.metadata.related_ids || []).forEach(to => edges.push({ from: m.id, to, type: 'explicit', weight: 1 })));

    for (let i = 0; i < memories.length; i++) {
      for (let j = i + 1; j < memories.length; j++) {
        const sharedTags = memories[i].metadata.tags.filter(t => memories[j].metadata.tags.includes(t));
        if (sharedTags.length) edges.push({ from: memories[i].id, to: memories[j].id, type: 'shared-tag', weight: sharedTags.length });
      }
    }
    return { nodes, edges, totalConnections: edges.length };
  }

  async getDeeperRelationshipGraph(namespace = 'default') {
    return this.getRelationshipGraph(namespace);
  }

  async generateInsights(namespace = 'default') {
    const memories = await this.loadMemories(namespace);
    const report = await this.dailyIntelligenceReport(namespace);
    const highQuality = memories.filter(m => this.computeQualityScore(m) >= 0.75).length;
    const stale = memories.filter(m => (Date.now() - new Date(m.updated_at).getTime()) > 1000 * 3600 * 24 * 90).length;
    return { insights: [...report.insights, `${highQuality} high-quality memories`, `${stale} stale memories`], memoryCount: memories.length };
  }

  async memoryHealthCheck(namespace = 'default') {
    const memories = await this.loadMemories(namespace);
    const items = memories
      .map(m => ({ id: m.id, quality: this.computeQualityScore(m), content: m.content.slice(0, 120), updated_at: m.updated_at }))
      .filter(m => m.quality < 0.4);
    return { total: memories.length, unhealthy: items.length, items, recommendations: items.length ? ['Review low-quality memories or merge duplicates'] : ['No urgent memory health issues'] };
  }

  async createAgent(agentId: string, name: string, config = {}) {
    return this.remember({ content: name, type: 'custom', namespace: 'agents', metadata: { ...(config as any), source: 'agent', tags: ['agent'], importance: 7 } as any });
  }

  async listAgents() {
    const agents = await this.loadMemories('agents');
    return agents.map(m => ({ agentId: (m.metadata as any).agentId || m.id, name: m.content, config: m.metadata }));
  }

  async indexFile(content: string, filename: string, namespace = 'default') {
    const chunks = content.split(/\n{2,}|(?<=\.)\s+/).map(c => c.trim()).filter(c => c.length > 20).slice(0, 50);
    const memories = await this.rememberBatch(chunks.map(chunk => ({ content: chunk, type: 'file', namespace, metadata: { source: `file:${filename}`, tags: [filename.split('.').pop() || 'file'], importance: 6 } })));
    return { indexed: memories.length, filename, namespace };
  }

  async exportMemories(namespace: string | null = null, format = 'json') {
    const memories = await this.loadMemories(namespace || undefined);
    if (format === 'csv') {
      const rows = ['id,type,namespace,content,created_at,updated_at'];
      memories.forEach(m => rows.push([m.id, m.type, m.namespace, `"${m.content.replace(/"/g, '""')}"`, m.created_at, m.updated_at].join(',')));
      return { format, count: memories.length, data: rows.join('\n') };
    }
    return { format: 'json', count: memories.length, data: memories };
  }

  async backupMemories(targetNamespace = 'backup') {
    const all = await this.store.readAll();
    const ts = new Date().toISOString();
    const copies = (all as Memory[]).map(m => ({ ...m, id: uuidv4(), namespace: targetNamespace, metadata: { ...m.metadata, source: `backup:${m.namespace}`, timestamp: ts } }));
    await this.saveMemories([...(all as Memory[]), ...copies], targetNamespace);
    return { backed_up: copies.length, target: targetNamespace };
  }

  async logAudit(action: string, details: any, namespace = 'default') {
    return this.remember({ content: `${action}: ${JSON.stringify(details).slice(0, 500)}`, type: 'custom', namespace: `audit-${namespace}`, metadata: { source: 'audit', tags: ['audit', action], importance: 4 } });
  }

  async getAuditTrail(namespace = 'default', limit = 20) {
    return this.list(`audit-${namespace}`, limit);
  }
}

let engine: MemoryEngine | null = null;

export function getMemoryEngine(): MemoryEngine {
  if (!engine) engine = new MemoryEngine();
  return engine;
}
