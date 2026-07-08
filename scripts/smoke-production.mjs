#!/usr/bin/env node
import crypto from 'node:crypto';

const baseUrl = (process.env.ZENOS_MEMORY_URL || 'https://zenos-memory.vercel.app').replace(/\/$/, '');
const secret = process.env.ETLA_MASTER_SECRET || process.env.ZENOS_MEMORY_SECRET;

function sign(method, path) {
  if (!secret) throw new Error('Set ETLA_MASTER_SECRET or ZENOS_MEMORY_SECRET');
  const ts = Date.now();
  const payload = `${ts}:${method.toUpperCase()}:${path}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return { 'x-etla-timestamp': String(ts), 'x-etla-signature': sig, 'content-type': 'application/json' };
}

async function request(method, path, body) {
  const res = await fetch(baseUrl + path, { method, headers: sign(method, path), body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function publicStatus() {
  const res = await fetch(baseUrl + '/api/memory/public-status');
  const data = await res.json();
  const allowedStatuses = new Set(['educational-demo', 'production-ready-learning-deployment']);
  if (!data.success || !allowedStatuses.has(data.status)) throw new Error('public-status failed');
  return data;
}

const checks = [];
checks.push(['public-status', await publicStatus()]);
checks.push(['hybrid-recall', await request('POST', '/api/memory/hybrid-recall', { query: 'Zenos Memory', namespace: 'zenos', limit: 2 })]);
checks.push(['mutation-plan', await request('POST', '/api/memory/mutation-plan', { content: 'Zenos Memory smoke test current state.', namespace: 'zenos', limit: 20 })]);
checks.push(['timeline', await request('GET', '/api/memory/timeline?namespace=zenos&limit=3')]);
checks.push(['episodes', await request('GET', '/api/memory/episodes?namespace=zenos&limit=3')]);
checks.push(['benchmark', await request('POST', '/api/memory/benchmark', { skip_llm: true })]);

console.log(JSON.stringify({ ok: true, baseUrl, checks: checks.map(([name, data]) => ({ name, count: data.count ?? data.case_count ?? null, status: data.status ?? 'ok' })) }, null, 2));
