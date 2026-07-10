import crypto from 'node:crypto';

const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');

export class ZenosMemoryClient {
  constructor({
    baseUrl = process.env.ZENOS_MEMORY_URL || 'https://zenos-memory.vercel.app',
    secret = process.env.ETLA_MASTER_SECRET || process.env.ZENOS_MEMORY_SECRET,
    namespace = process.env.ZENOS_MEMORY_NAMESPACE || 'zenos',
    clientId = 'zenos-js-sdk',
    timeoutMs = 30_000,
  } = {}) {
    if (!secret) throw new Error('ZenosMemoryClient requires ETLA_MASTER_SECRET or ZENOS_MEMORY_SECRET');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.secret = secret;
    this.namespace = namespace;
    this.clientId = clientId;
    this.timeoutMs = timeoutMs;
    this.tokens = new Map();
  }

  signTokenExchange(scopes) {
    const method = 'POST';
    const path = '/api/auth';
    const timestamp = Date.now();
    const nonce = crypto.randomBytes(18).toString('base64url');
    const canonical = [
      'zenos-memory-signature-v2',
      timestamp,
      nonce,
      method,
      path,
      EMPTY_SHA256,
    ].join('\n');
    const signature = crypto.createHmac('sha256', this.secret).update(canonical).digest('hex');
    return {
      'x-etla-timestamp': String(timestamp),
      'x-etla-nonce': nonce,
      'x-etla-content-sha256': EMPTY_SHA256,
      'x-etla-signature': signature,
      'x-etla-client-id': this.clientId,
      'x-etla-requested-scopes': scopes.join(' '),
      'content-type': 'application/json',
    };
  }

  async token(scopes = ['memory:read', 'memory:write']) {
    const key = [...scopes].sort().join(' ');
    const cached = this.tokens.get(key);
    if (cached && Date.now() < cached.expiresAt - 30_000) return cached.value;
    const response = await fetch(`${this.baseUrl}/api/auth`, {
      method: 'POST',
      headers: this.signTokenExchange(scopes),
      signal: AbortSignal.timeout(this.timeoutMs),
      cache: 'no-store',
    });
    const data = await this.readResponse(response);
    if (typeof data.token !== 'string') throw new Error('Zenos token exchange returned no token');
    this.tokens.set(key, {
      value: data.token,
      expiresAt: Date.now() + Number(data.expires_in || 900) * 1000,
    });
    return data.token;
  }

  async readResponse(response) {
    const text = await response.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`Zenos returned non-JSON response (${response.status})`);
      }
    }
    if (!response.ok) {
      const message = data?.error?.message || data?.error || `HTTP ${response.status}`;
      const error = new Error(String(message));
      error.status = response.status;
      error.code = data?.error?.code;
      error.requestId = data?.request_id || response.headers.get('x-request-id');
      throw error;
    }
    return data;
  }

  async request(method, path, body, { scopes, idempotencyKey } = {}) {
    const requiredScopes = scopes || (method === 'GET' || method === 'HEAD' ? ['memory:read'] : ['memory:read', 'memory:write']);
    const token = await this.token(requiredScopes);
    const headers = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    };
    let payload;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    const response = await fetch(this.baseUrl + path, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(this.timeoutMs),
      cache: 'no-store',
    });
    if (response.status === 401) {
      this.tokens.clear();
    }
    return this.readResponse(response);
  }

  remember(content, options = {}) {
    return this.request('POST', '/api/memory/remember', {
      content,
      type: options.type,
      namespace: options.namespace || this.namespace,
      metadata: options.metadata || {},
    }, { idempotencyKey: options.idempotencyKey });
  }

  rememberBatch(memories, options = {}) {
    return this.request('POST', '/api/memory/remember-batch', { memories }, { idempotencyKey: options.idempotencyKey });
  }

  recall(query, options = {}) {
    return this.request('POST', '/api/memory/hybrid-recall', {
      query,
      namespace: options.namespace || this.namespace,
      type: options.type,
      limit: options.limit || 10,
      tags: options.tags,
      include_low_quality: Boolean(options.includeLowQuality),
      include_archived: Boolean(options.includeArchived),
    }, { scopes: ['memory:read'] });
  }

  edit(id, updates, options = {}) {
    return this.request('PATCH', '/api/memory/edit', {
      id,
      ...updates,
      namespace: options.namespace || this.namespace,
      expected_version: options.expectedVersion,
    });
  }

  forget(id, options = {}) {
    return this.request('DELETE', '/api/memory/forget', {
      id,
      namespace: options.namespace || this.namespace,
      expected_version: options.expectedVersion,
      hard_delete: Boolean(options.hardDelete),
    });
  }

  compact(messages, options = {}) {
    return this.request('POST', '/api/memory/compact', {
      messages,
      namespace: options.namespace || this.namespace,
      reason: options.reason || 'sdk',
      session_id: options.sessionId,
      conversation_id: options.conversationId,
    }, { idempotencyKey: options.idempotencyKey });
  }

  bootstrap(options = {}) {
    return this.request('POST', '/api/memory/bootstrap', {
      namespace: options.namespace || this.namespace,
      queries: options.queries,
      limit: options.limit,
      max_chars: options.maxChars,
    }, { scopes: ['memory:read'] });
  }

  stats(options = {}) {
    const parameters = new URLSearchParams();
    if (options.namespace || this.namespace) parameters.set('namespace', options.namespace || this.namespace);
    return this.request('GET', `/api/memory/stats?${parameters.toString()}`, undefined, { scopes: ['memory:read'] });
  }

  backup(options = {}) {
    return this.request('POST', '/api/memory/backup', {
      namespace: options.namespace,
    }, { scopes: ['memory:admin'] });
  }

  restore(snapshot, options = {}) {
    return this.request('POST', '/api/memory/restore', {
      snapshot,
      mode: options.mode || 'merge',
      namespace: options.namespace,
    }, { scopes: ['memory:admin'] });
  }

  acquireLease(resource, owner, options = {}) {
    return this.request('POST', '/api/memory/lock', {
      action: 'acquire',
      resource,
      owner,
      namespace: options.namespace || this.namespace,
      ttl_ms: options.ttlMs || 30_000,
    }, { scopes: ['memory:admin'] });
  }

  releaseLease(token, owner) {
    return this.request('POST', '/api/memory/lock', {
      action: 'release',
      token,
      owner,
    }, { scopes: ['memory:admin'] });
  }

  health(options = {}) {
    const parameters = new URLSearchParams({ namespace: options.namespace || this.namespace });
    return this.request('GET', `/api/memory/health-check?${parameters.toString()}`, undefined, { scopes: ['memory:read'] });
  }
}
