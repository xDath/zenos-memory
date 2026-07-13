import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

function parseEnvFile(filename) {
  if (!existsSync(filename)) return {};
  const values = {};
  for (const rawLine of readFileSync(filename, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      const doubleQuoted = value.startsWith('"');
      value = value.slice(1, -1);
      if (doubleQuoted) {
        value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values[match[1]] = value;
  }
  return values;
}

function loadEnv(filename, overwrite = false) {
  for (const [key, value] of Object.entries(parseEnvFile(filename))) {
    if (overwrite || process.env[key] === undefined) process.env[key] = value;
  }
}

function alias(target, ...sources) {
  if (process.env[target]) return;
  for (const source of sources) {
    if (process.env[source]) {
      process.env[target] = process.env[source];
      return;
    }
  }
}

export function loadZenosRuntimeEnv(projectRoot = path.resolve(import.meta.dirname, '..')) {
  const credentialDirectory = process.env.CREDENTIALS_DIRECTORY || '';
  for (const filename of [
    credentialDirectory ? path.join(credentialDirectory, 'zenos-memory.env') : '',
    '/root/.hermes/profiles/zenos/.env',
    '/root/.hermes/.env',
    path.join(projectRoot, '.env.production.local'),
    path.join(projectRoot, '.env.local'),
  ]) {
    loadEnv(filename);
  }

  alias('GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_CLIENT_ID');
  alias('GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_CLIENT_SECRET');
  alias('GOOGLE_OAUTH_REFRESH_TOKEN', 'GOOGLE_REFRESH_TOKEN');
  alias('MEMORY_LLM_BASE_URL', 'LLM_BASE_URL');
  alias('MEMORY_LLM_API_KEY', 'LLM_API_KEY');
  alias('MEMORY_LLM_MODEL', 'LLM_MODEL');
  alias('ZENOS_MEMORY_SECRET', 'ETLA_MASTER_SECRET');

  process.env.NODE_ENV = 'production';
  process.env.PORT ||= '3091';
  process.env.HOSTNAME ||= '127.0.0.1';
  process.env.ZENOS_MEMORY_URL ||= `http://${process.env.HOSTNAME}:${process.env.PORT}`;
  process.env.ZENOS_MEMORY_DB_PATH ||= '/var/lib/zenos-memory/zenos-memory.sqlite';
  process.env.ZENOS_MEMORY_BACKUP_DIR ||= '/var/lib/zenos-memory/backups';
  process.env.ZENOS_MEMORY_DEFAULT_NAMESPACE ||= process.env.ZENOS_MEMORY_NAMESPACE || 'zenos';
  process.env.ZENOS_MEMORY_IMPORT_LEGACY_ON_START ||= 'true';
  process.env.ZENOS_MEMORY_ALLOW_INSECURE_DEV = 'false';
  process.env.ZENOS_MEMORY_ALLOW_STATIC_API_KEY = 'false';
  process.env.ZENOS_MEMORY_ALLOW_LEGACY_HMAC ||= 'false';
  process.env.ZENOS_MEMORY_ALLOW_ADMIN_TOKEN_EXCHANGE ||= 'true';
  process.env.ZENOS_MEMORY_REQUIRE_DRIVE_BACKUP ||= (
    process.env.GOOGLE_OAUTH_REFRESH_TOKEN && (process.env.ZENOS_MEMORY_DRIVE_FOLDER_ID || process.env.GOOGLE_DRIVE_FOLDER_NAME)
      ? 'true'
      : 'false'
  );
  return process.env;
}
