#!/usr/bin/env node
import path from 'node:path';
import { createDriveStore, hasDriveConfiguration } from '../app/lib/drive';
import { loadZenosRuntimeEnv } from './runtime-env.mjs';

loadZenosRuntimeEnv(path.resolve(import.meta.dirname, '..'));
if (!hasDriveConfiguration()) {
  process.stdout.write('{"configured":false}\n');
  process.exit(0);
}
const files = await createDriveStore().listFilesInFolder();
process.stdout.write(`${JSON.stringify({
  configured: true,
  count: files.length,
  files: files.map(file => ({
    id: file.id,
    name: file.name,
    mime_type: file.mimeType,
    modified_at: file.modifiedTime,
    size: file.size,
  })),
}, null, 2)}\n`);
