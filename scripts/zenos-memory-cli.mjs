#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { ZenosMemoryClient } from '../sdk/js/zenos-memory-client.mjs';
import { loadZenosRuntimeEnv } from './runtime-env.mjs';

loadZenosRuntimeEnv(process.cwd());

const [command, ...args] = process.argv.slice(2);

function usage() {
  process.stdout.write(`Zenos Memory CLI 2.0

Usage:
  npm run cli -- remember <text> [namespace]
  npm run cli -- recall <query> [namespace]
  npm run cli -- compact <messages.json> [namespace]
  npm run cli -- stats [namespace]
  npm run cli -- health [namespace]
  npm run cli -- backup [namespace]
  npm run cli -- reindex [namespace]
  npm run cli -- restore <snapshot.json> [merge|replace] [namespace]

Environment:
  ZENOS_MEMORY_URL=https://zenos-memory.vercel.app
  ETLA_MASTER_SECRET=<shared-secret>
  ZENOS_MEMORY_NAMESPACE=zenos
`);
}

async function main() {
  if (!command || command === 'help' || command === '--help') {
    usage();
    return;
  }
  const client = new ZenosMemoryClient({ timeoutMs: 180_000 });
  let result;
  switch (command) {
    case 'remember': {
      const [content, namespace] = args;
      if (!content) throw new Error('remember requires text');
      result = await client.remember(content, { namespace, idempotencyKey: `cli-${Date.now()}` });
      break;
    }
    case 'recall': {
      const [query, namespace] = args;
      if (!query) throw new Error('recall requires a query');
      result = await client.recall(query, { namespace });
      break;
    }
    case 'compact': {
      const [filename, namespace] = args;
      if (!filename) throw new Error('compact requires a JSON messages file');
      const messages = JSON.parse(await readFile(filename, 'utf8'));
      result = await client.compact(messages, { namespace, reason: 'cli', idempotencyKey: `cli-compact-${Date.now()}` });
      break;
    }
    case 'stats':
      result = await client.stats({ namespace: args[0] });
      break;
    case 'health':
      result = await client.health({ namespace: args[0] });
      break;
    case 'backup':
      result = await client.backup({ namespace: args[0] });
      break;
    case 'reindex':
      result = await client.reindex({ namespace: args[0] });
      break;
    case 'restore': {
      const [filename, mode = 'merge', namespace] = args;
      if (!filename) throw new Error('restore requires a snapshot JSON file');
      if (!['merge', 'replace'].includes(mode)) throw new Error('restore mode must be merge or replace');
      const snapshot = JSON.parse(await readFile(filename, 'utf8'));
      result = await client.restore(snapshot, { mode, namespace });
      break;
    }
    default:
      usage();
      process.exitCode = 2;
      return;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

void main().catch(error => {
  const requestId = error?.requestId ? ` request_id=${error.requestId}` : '';
  process.stderr.write(`Zenos CLI error: ${error instanceof Error ? error.message : String(error)}${requestId}\n`);
  process.exitCode = 1;
});
