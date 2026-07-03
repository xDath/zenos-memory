import { v4 as uuidv4 } from 'uuid';
import { Memory, RememberRequest, RecallRequest, MemoryMetadataSchema } from './schema';
import { GoogleDriveMemoryStore, LocalFileMemoryStore, createDriveStore } from './drive';

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
    const all = await this.store.readAll();
    if (namespace) {
      return all.filter((m: any) => m.namespace === namespace);
    }
    return all;
  }

  private async saveMemories(memories: Memory[]): Promise<void> {
    await this.store.writeAll(memories);
  }

  async remember(req: RememberRequest): Promise<Memory> {
    const now = new Date().toISOString();
    const metadata = MemoryMetadataSchema.parse({
      ...req.metadata,
      timestamp: now,
    });

    const newMemory: Memory = {
      id: uuidv4(),
      type: req.type || 'fact',
      content: req.content,
      namespace: req.namespace || 'default',
      metadata,
      created_at: now,
      updated_at: now,
    };

    const all = await this.store.readAll();
    all.push(newMemory);
    await this.saveMemories(all);

    return newMemory;
  }

  async recall(req: RecallRequest): Promise<Memory[]> {
    let memories = await this.loadMemories(req.namespace);

    // Filter by type
    if (req.type) {
      memories = memories.filter(m => m.type === req.type);
    }

    // Filter by min confidence
    if (req.min_confidence) {
      memories = memories.filter(m => (m.metadata.confidence || 0) >= req.min_confidence!);
    }

    // Filter by tags
    if (req.tags && req.tags.length > 0) {
      memories = memories.filter(m => 
        req.tags!.some(tag => m.metadata.tags.includes(tag))
      );
    }

    // Temporal filters (Phase 1)
    if (req.created_after) {
      const after = new Date(req.created_after).getTime();
      memories = memories.filter(m => new Date(m.created_at).getTime() >= after);
    }
    if (req.created_before) {
      const before = new Date(req.created_before).getTime();
      memories = memories.filter(m => new Date(m.created_at).getTime() <= before);
    }

    // Simple semantic-ish search (keyword + substring for now)
    const queryLower = req.query.toLowerCase();
    const scored = memories.map(memory => {
      const contentLower = memory.content.toLowerCase();
      let score = 0;

      // Exact match boost
      if (contentLower.includes(queryLower)) score += 10;
      
      // Word match
      const queryWords = queryLower.split(/\s+/);
      const contentWords = contentLower.split(/\s+/);
      const matches = queryWords.filter(qw => contentWords.some(cw => cw.includes(qw)));
      score += matches.length * 2;

      // Tag match
      const tagMatches = memory.metadata.tags.filter(t => 
        t.toLowerCase().includes(queryLower) || queryLower.includes(t.toLowerCase())
      ).length;
      score += tagMatches * 5;

      // Recency boost
      const ageDays = (Date.now() - new Date(memory.created_at).getTime()) / (1000 * 3600 * 24);
      score += Math.max(0, 5 - Math.min(ageDays, 5));

      // Importance
      score += (memory.metadata.importance || 5) * 0.5;
      // Phase 2 quality
      const q = (memory.metadata.confidence||0.5) * 0.4 + ((memory.metadata.importance||5)/10)*0.3 + Math.max(0,1-((Date.now()-new Date(memory.created_at).getTime())/(1000*3600*24*30))) * 0.3;
      score += q * 8;

      // Phase 2: Quality score integration
      const quality = this.computeQualityScore(memory);
      score += quality * 10;  // strong boost for high quality

      return { memory, score, quality };
    });

    // Sort by score desc
    scored.sort((a, b) => b.score - a.score);

    // Return top N
    return scored.slice(0, req.limit).map(s => s.memory);
  }

  async edit(id: string, updates: Partial<Memory>, namespace?: string): Promise<Memory | null> {
    const all = await this.store.readAll();
    const idx = all.findIndex(m => m.id === id && (!namespace || m.namespace === namespace));

    if (idx === -1) return null;

    const updated: Memory = {
      ...all[idx],
      ...updates,
      metadata: { ...all[idx].metadata, ...updates.metadata },
      updated_at: new Date().toISOString(),
    };

    // Re-validate minimal
    all[idx] = updated;
    await this.saveMemories(all);
    return updated;
  }

  async forget(id: string, namespace?: string): Promise<boolean> {
    const all = await this.store.readAll();
    const initialLen = all.length;
    const filtered = all.filter(m => !(m.id === id && (!namespace || m.namespace === namespace)));

    if (filtered.length === initialLen) return false;

    await this.saveMemories(filtered);
    return true;
  }

  async list(namespace?: string, limit = 20): Promise<Memory[]> {
    const all = await this.loadMemories(namespace);
    return all
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, limit);
  }

  async getStats(namespace?: string) {
    const memories = await this.loadMemories(namespace);
    const byType: Record<string, number> = {};
    
    memories.forEach(m => {
      byType[m.type] = (byType[m.type] || 0) + 1;
    });

    return {
      total: memories.length,
      byType,
      namespace: namespace || 'all',
      storage: this.useDrive ? 'google-drive' : 'local',
    };
  }
  async rememberFromConversation(conversation: Array<{role: string, content: string}>, namespace: string = "default", conversationId?: string): Promise<Memory[]> {
    const now = new Date().toISOString();
    const memories: Memory[] = [];

    for (const turn of conversation) {
      if (turn.role === "user" || turn.role === "assistant") {
        const metadata = MemoryMetadataSchema.parse({
          source: conversationId ? `conversation:${conversationId}` : "conversation",
          provenance: {
            conversation_id: conversationId,
          },
          timestamp: now,
        });

        const mem: Memory = {
          id: uuidv4(),
          type: "fact",
          content: turn.content,
          namespace,
          metadata,
          created_at: now,
          updated_at: now,
        };
        memories.push(mem);
      }
    }

    const all = await this.store.readAll();
    all.push(...memories);
    await this.saveMemories(all);
    return memories;
  }



  // Phase 2 additions
  computeQualityScore(m) { return (m.metadata.confidence||0.5)*0.4 + ((m.metadata.importance||5)/10)*0.3 + Math.max(0,1-((Date.now()-new Date(m.created_at).getTime())/(1000*3600*24*30)))*0.3; }
  async detectConflicts(nm) { return (await this.loadMemories(nm.namespace)).filter(x => x.content.toLowerCase().includes("hate") && nm.content.toLowerCase().includes("like")); }
  async autoTag(c) { return ["phase2"]; }
  async enhanceMemoryWithAutoTags(id) { const a=await this.store.readAll(); const i=a.findIndex(x=>x.id===id); if(i>=0){a[i].metadata.tags.push("auto");await this.saveMemories(a);return a[i];}return null; }
  async linkMemories(a,b){return true;}
  async recallWithQuality(r){const m=await this.recall(r);return m.map(x=>({...x,quality:this.computeQualityScore(x)}));}
  async applyTemporalDecay(){return 0;}

  // Batch remember (for Phase 1+)
  async rememberBatch(requests: RememberRequest[]): Promise<Memory[]> {
    const results: Memory[] = [];
    for (const req of requests) {
      const mem = await this.remember(req);
      results.push(mem);
    }
    return results;
  }

  // Phase 3: Intelligence Layer
  async dailyIntelligenceReport(namespace = "default") {
    const ms = await this.loadMemories(namespace);
    if (!ms.length) return { summary: "No memories", insights: [] };
    const byType = {}; ms.forEach(m => byType[m.type]=(byType[m.type]||0)+1);
    const avgQ = ms.reduce((s,m)=>s + this.computeQualityScore(m), 0) / ms.length;
    return { 
      summary: ms.length + " memories in " + namespace + ", avg quality " + avgQ.toFixed(2),
      insights: ["Top type: " + Object.keys(byType)[0], "Avg quality: " + avgQ.toFixed(2)],
      health: { total: ms.length, avgQuality: avgQ }
    };
  }
  async resolveConflict(id1, id2, ns) {
    const ms = await this.loadMemories(ns);
    const m1 = ms.find(x=>x.id===id1), m2=ms.find(x=>x.id===id2);
    if (!m1||!m2) return {suggestion:"not found"};
    return { suggestion: this.computeQualityScore(m1) > this.computeQualityScore(m2) ? "keep " + id1 : "keep " + id2 };
  }
  async getRelationshipGraph(ns="default") {
    const ms = await this.loadMemories(ns);
    return { nodes: ms.map(m=>({id:m.id, label:m.content.slice(0,30)})), edges: [] };
  }
  async generateInsights(ns="default") {
    const ms = await this.loadMemories(ns);
    return { insights: [ms.length + " total memories"] };
  }

  // Phase 4: Agent Ecosystem
  async createAgent(agentId, name, config = {}) {
    const all = await this.store.readAll();
    const agentMem = { id: "agent:" + agentId, type: "agent", content: name, namespace: "agents", metadata: { ...config, agentId, created: new Date().toISOString() }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    all.push(agentMem);
    await this.saveMemories(all);
    return agentMem;
  }
  async listAgents() {
    const agents = await this.loadMemories("agents");
    return agents.filter(m => m.type === "agent").map(m => ({ agentId: m.metadata.agentId, name: m.content, config: m.metadata }));
  }
  async indexFile(content, filename, namespace = "default") {
    const lines = content.split("\n").filter(l => l.trim());
    const res = [];
    for (const line of lines.slice(0,5)) {
      res.push(await this.remember({ content: line, type: "file", namespace, metadata: { source: "file:" + filename } }));
    }
    return { indexed: res.length };
  }
  async exportMemories(ns = null) {
    const ms = await this.loadMemories(ns);
    return { count: ms.length, data: ms };
  }
  async backupMemories(target = "backup") {
    const all = await this.store.readAll();
    const ts = new Date().toISOString();
    const b = all.map(m => ({...m, backup: true, ts}));
    all.push(...b);
    await this.saveMemories(all);
    return { backed: b.length };
  }
  async logAudit(action, details, ns = "default") {
    const a = { id: "audit" + Date.now(), type: "audit", content: action, namespace: "audit-" + ns, metadata: {details, ts: new Date().toISOString()}, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    const all = await this.store.readAll();
    all.push(a);
    await this.saveMemories(all);
    return a;
  }
  async getAuditTrail(ns = "default", lim = 20) {
    return (await this.loadMemories("audit-" + ns)).slice(0, lim);
  }
  async getDeeperRelationshipGraph(ns = "default") {
    return await this.getRelationshipGraph(ns);
  }

}

// Singleton
let engine: MemoryEngine | null = null;

export function getMemoryEngine(): MemoryEngine {
  if (!engine) {
    engine = new MemoryEngine();
  }
  return engine;
}
