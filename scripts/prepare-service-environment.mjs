#!/usr/bin/env node
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [, , output, ...arguments_] = process.argv;
const runtimeMarker = arguments_.indexOf('--runtime');
if (!output || runtimeMarker < 0 || runtimeMarker === arguments_.length - 1) {
  throw new Error('usage: prepare-service-environment.mjs OUTPUT MEMORY_SOURCE... --runtime RUNTIME_SOURCE');
}

function parseEnvironment(filename) {
  const values = new Map();
  try {
    for (const sourceLine of readFileSync(filename, 'utf8').split(/\r?\n/)) {
      const line = sourceLine.trim();
      if (!line || line.startsWith('#')) continue;
      const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (match) values.set(match[1], match[2].trim());
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return values;
}

function allowedMemoryKey(key) {
  return key === 'ETLA_MASTER_SECRET'
    || key === 'CRON_SECRET'
    || key === 'NODE_ENV'
    || key === 'PORT'
    || key.startsWith('ZENOS_MEMORY_')
    || key.startsWith('MEMORY_LLM_')
    || key.startsWith('MEMORY_EMBEDDING_')
    || key.startsWith('MEMORY_SEMANTIC_EXPANSION_')
    || key.startsWith('GOOGLE_OAUTH_')
    || key.startsWith('GOOGLE_DRIVE_')
    || key.startsWith('GOOGLE_SERVICE_ACCOUNT_')
    || ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'].includes(key);
}

function unquoted(value = '') {
  return value.trim().replace(/^(['"])(.*)\1$/, '$2');
}

const values = new Map();
for (const filename of arguments_.slice(0, runtimeMarker)) {
  for (const [key, value] of parseEnvironment(filename)) {
    if (!allowedMemoryKey(key)) continue;
    if (!values.has(key) || (!unquoted(values.get(key)) && unquoted(value))) values.set(key, value);
  }
}

// This generator is used by the VPS sidecar installer. Keep service-to-service
// traffic on loopback; the separately deployed Vercel endpoint remains an
// external recovery surface, not the local Runtime's primary dependency.
values.set('ZENOS_MEMORY_URL', 'http://127.0.0.1:3091');

const runtime = parseEnvironment(arguments_[runtimeMarker + 1]);
const driveAliases = new Map([
  ['GOOGLE_OAUTH_CLIENT_ID', ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_CLIENT_ID']],
  ['GOOGLE_OAUTH_CLIENT_SECRET', ['GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_CLIENT_SECRET']],
  ['GOOGLE_OAUTH_REFRESH_TOKEN', ['GOOGLE_OAUTH_REFRESH_TOKEN', 'GOOGLE_REFRESH_TOKEN']],
]);
for (const [canonical, aliases] of driveAliases) {
  const candidate = aliases.map((key) => values.get(key) || runtime.get(key)).find((value) => unquoted(value));
  if (candidate) values.set(canonical, candidate);
  for (const alias of aliases) {
    if (alias !== canonical) values.delete(alias);
  }
}
if (!values.has('GOOGLE_DRIVE_FOLDER_NAME') && runtime.get('GOOGLE_DRIVE_FOLDER_NAME')) {
  values.set('GOOGLE_DRIVE_FOLDER_NAME', runtime.get('GOOGLE_DRIVE_FOLDER_NAME'));
}
const routerKey = runtime.get('ZENOS_LLM_API_KEY') || runtime.get('LLM_API_KEY');
if (unquoted(routerKey)) {
  Object.entries({
    MEMORY_LLM_API_KEY: routerKey,
    MEMORY_LLM_BASE_URL: 'http://127.0.0.1:20128/v1',
    MEMORY_LLM_MODEL: 'ag/gemini-pro-agent',
    MEMORY_LLM_FALLBACK_MODEL: 'ag/gemini-3.5-flash-low',
    MEMORY_LLM_TIMEOUT_MS: '45000',
    MEMORY_LLM_TOTAL_BUDGET_MS: '80000',
    MEMORY_SEMANTIC_EXPANSION_ENABLED: 'true',
    MEMORY_SEMANTIC_EXPANSION_MODEL: 'ag/gemini-3.5-flash-low',
    MEMORY_SEMANTIC_EXPANSION_FALLBACK_MODEL: 'ag/gemini-3-flash',
    MEMORY_SEMANTIC_EXPANSION_TIMEOUT_MS: '25000',
    MEMORY_SEMANTIC_EXPANSION_TOTAL_BUDGET_MS: '45000',
  }).forEach(([key, value]) => values.set(key, value));
}

if (![...values.values()].some((value) => unquoted(value))) {
  throw new Error('No Zenos Memory credential source was found');
}
writeFileSync(output, [...values].sort(([left], [right]) => left.localeCompare(right))
  .map(([key, value]) => `${key}=${value}\n`).join(''), { mode: 0o600 });
chmodSync(output, 0o600);
process.stdout.write(`${JSON.stringify({ ok: true, output: path.basename(output), keys: values.size })}\n`);
