#!/usr/bin/env node
import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { ZenosMemoryClient } from '../sdk/js/zenos-memory-client.mjs';

function loadCredential(name) {
  const directory = process.env.CREDENTIALS_DIRECTORY || '';
  const file = directory ? path.join(directory, name) : '';
  if (!file || !existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim().replace(/^export\s+/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key]) continue;
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

function decryptEnvelope(envelope) {
  const candidates = [...new Set([
    process.env.ZENOS_BACKUP_ENCRYPTION_KEY,
    process.env.ZENOS_MEMORY_SECONDARY_BACKUP_SECRET,
    process.env.ETLA_MASTER_SECRET,
    process.env.ZENOS_MEMORY_SECRET,
    process.env.ZENOS_MEMORY_API_KEY,
  ].filter(Boolean))];
  for (const secret of candidates) {
    try {
      const key = crypto.scryptSync(secret, Buffer.from(envelope.salt, 'base64'), 32);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const compressed = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]);
      const plaintext = gunzipSync(compressed);
      const checksum = crypto.createHash('sha256').update(plaintext).digest('hex');
      if (checksum !== envelope.checksum) continue;
      return JSON.parse(plaintext.toString('utf8'));
    } catch {
      // Try the next configured historical key without disclosing which key matched.
    }
  }
  throw new Error('Backup could not be decrypted and checksum-verified with configured historical keys');
}

function memorySnapshot(payload, namespace) {
  const memories = payload?.exported?.data;
  if (!Array.isArray(memories) || memories.length === 0) throw new Error('Backup contains no exported memories');
  const ids = new Set();
  for (const memory of memories) {
    if (!memory || typeof memory !== 'object' || typeof memory.id !== 'string') throw new Error('Backup memory contract is invalid');
    if (ids.has(memory.id)) throw new Error(`Backup contains duplicate memory id ${memory.id}`);
    ids.add(memory.id);
  }
  const checksum = crypto.createHash('sha256').update(JSON.stringify(memories)).digest('hex');
  return {
    format: 'zenos-memory-snapshot-v1',
    generated_at: payload?.exported?.generated_at || payload?.created_at || new Date().toISOString(),
    namespace,
    checksum,
    memories,
  };
}

async function main() {
  loadCredential('zenos-runtime.env');
  loadCredential('zenos-memory.env');
  const backupPath = process.argv[2];
  if (!backupPath || !existsSync(backupPath)) throw new Error('Usage: migrate-encrypted-local-backup-to-cloud.mjs BACKUP_FILE');
  const envelope = JSON.parse(readFileSync(backupPath, 'utf8'));
  if (envelope.format !== 'zenos-memory-secondary-backup-v1') throw new Error('Unsupported backup format');
  const payload = decryptEnvelope(envelope);
  const namespace = String(envelope.namespace || process.env.ZENOS_MEMORY_NAMESPACE || 'zenos');
  const snapshot = memorySnapshot(payload, namespace);
  const client = new ZenosMemoryClient({
    baseUrl: process.env.ZENOS_MEMORY_URL || 'https://zenos-memory.vercel.app',
    namespace,
    clientId: 'zenos-local-backup-cloud-migration',
    timeoutMs: Math.max(180_000, Math.min(Number(process.env.ZENOS_MEMORY_MIGRATION_TIMEOUT_MS || 300_000), 300_000)),
  });

  const before = await client.request('GET', `/api/memory/export?namespace=${encodeURIComponent(namespace)}&format=json`, undefined, { scopes: ['memory:read'] });
  const restored = await client.restore(snapshot, { mode: 'merge', namespace });
  const after = await client.request('GET', `/api/memory/export?namespace=${encodeURIComponent(namespace)}&format=json`, undefined, { scopes: ['memory:read'] });
  const cloudMemories = Array.isArray(after?.exported?.data) ? after.exported.data : [];
  const cloudIds = new Set(cloudMemories.map(memory => memory?.id).filter(Boolean));
  const missing = snapshot.memories.map(memory => memory.id).filter(id => !cloudIds.has(id));
  if (missing.length) throw new Error(`Cloud verification failed: ${missing.length} source memory ids are missing`);
  const backup = await client.backup({ namespace });
  if (!backup?.success || backup?.backup?.verified !== true) throw new Error('Post-migration Drive snapshot verification failed');

  console.log(JSON.stringify({
    ok: true,
    namespace,
    sourceCount: snapshot.memories.length,
    cloudCountBefore: Number(before?.exported?.count || 0),
    cloudCountAfter: Number(after?.exported?.count || 0),
    restore: restored?.restore,
    missingSourceIds: 0,
    sourceChecksum: snapshot.checksum,
    driveSnapshotVerified: true,
    sourceBackupPreserved: path.basename(backupPath),
  }, null, 2));
}

main().catch(error => {
  console.error(JSON.stringify({
    ok: false,
    service: 'zenos-local-backup-cloud-migration',
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exit(1);
});
