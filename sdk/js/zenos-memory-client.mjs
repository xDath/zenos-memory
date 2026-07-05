import crypto from 'node:crypto';

export class ZenosMemoryClient {
  constructor({ baseUrl = 'https://zenos-memory.vercel.app', secret = process.env.ETLA_MASTER_SECRET || process.env.ZENOS_MEMORY_SECRET } = {}) {
    if (!secret) throw new Error('ZenosMemoryClient requires secret');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.secret = secret;
  }

  sign(method, path) {
    const ts = Date.now();
    const payload = `${ts}:${method.toUpperCase()}:${path}`;
    const sig = crypto.createHmac('sha256', this.secret).update(payload).digest('hex');
    return { 'x-etla-timestamp': String(ts), 'x-etla-signature': sig, 'content-type': 'application/json' };
  }

  async request(method, path, body) {
    const res = await fetch(this.baseUrl + path, { method, headers: this.sign(method, path), body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(data)}`);
    return data;
  }

  remember(content, options = {}) {
    return this.request('POST', '/api/memory/remember', { content, type: options.type || 'fact', namespace: options.namespace || 'zenos', metadata: options.metadata || {} });
  }

  recall(query, options = {}) {
    return this.request('POST', '/api/memory/hybrid-recall', { query, namespace: options.namespace || 'zenos', limit: options.limit || 10, include_secrets: !!options.include_secrets, include_low_quality: !!options.include_low_quality });
  }

  compact(messages, options = {}) {
    return this.request('POST', '/api/memory/compact', { messages, namespace: options.namespace || 'zenos', reason: options.reason || 'sdk' });
  }

  ingest(filename, content, options = {}) {
    return this.request('POST', '/api/memory/upload', { filename, content, namespace: options.namespace || 'zenos', agentId: options.agentId });
  }

  timeline(options = {}) {
    const params = new URLSearchParams({ namespace: options.namespace || 'zenos', limit: String(options.limit || 100) });
    if (options.entity) params.set('entity', options.entity);
    return this.request('GET', `/api/memory/timeline?${params.toString()}`);
  }

  mutationPlan(content, options = {}) {
    return this.request('POST', '/api/memory/mutation-plan', { content, namespace: options.namespace || 'zenos', limit: options.limit || 200 });
  }

  benchmark(options = {}) {
    return this.request('POST', '/api/memory/benchmark', { skip_llm: options.skip_llm !== false });
  }
}
