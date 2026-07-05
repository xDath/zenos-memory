#!/usr/bin/env node
import crypto from 'node:crypto';

const [cmd, ...args] = process.argv.slice(2);
const baseUrl = (process.env.ZENOS_MEMORY_URL || 'https://zenos-memory.vercel.app').replace(/\/$/, '');
const secret = process.env.ETLA_MASTER_SECRET || process.env.ZENOS_MEMORY_SECRET || '';

function sign(method, path) {
  const ts = Date.now();
  const payload = `${ts}:${method.toUpperCase()}:${path}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return { 'x-etla-timestamp': String(ts), 'x-etla-signature': sig, 'content-type': 'application/json' };
}

async function request(method, path, body) {
  if (!secret) throw new Error('Set ETLA_MASTER_SECRET or ZENOS_MEMORY_SECRET');
  const res = await fetch(baseUrl + path, { method, headers: sign(method, path), body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

function usage() {
  console.log(`Usage:
  zenos-memory-cli remember <text> [namespace]
  zenos-memory-cli recall <query> [namespace]
  zenos-memory-cli compact <json-messages-file> [namespace]
  zenos-memory-cli ingest <filename> <text> [namespace]

Env:
  ZENOS_MEMORY_URL=https://zenos-memory.vercel.app
  ETLA_MASTER_SECRET=<secret>`);
}

try {
  if (!cmd || cmd === 'help') {
    usage();
  } else if (cmd === 'remember') {
    const [content, namespace = 'zenos'] = args;
    console.log(JSON.stringify(await request('POST', '/api/memory/remember', { content, namespace, type: 'fact' }), null, 2));
  } else if (cmd === 'recall') {
    const [query, namespace = 'zenos'] = args;
    console.log(JSON.stringify(await request('POST', '/api/memory/recall', { query, namespace, limit: 10 }), null, 2));
  } else if (cmd === 'compact') {
    const [file, namespace = 'zenos'] = args;
    const fs = await import('node:fs/promises');
    const messages = JSON.parse(await fs.readFile(file, 'utf8'));
    console.log(JSON.stringify(await request('POST', '/api/memory/compact', { messages, namespace, reason: 'cli' }), null, 2));
  } else if (cmd === 'ingest') {
    const [filename, content, namespace = 'zenos'] = args;
    console.log(JSON.stringify(await request('POST', '/api/memory/upload', { filename, content, namespace }), null, 2));
  } else {
    usage();
    process.exitCode = 1;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
