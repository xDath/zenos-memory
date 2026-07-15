#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';

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

loadCredential('zenos-runtime.env');
loadCredential('zenos-memory.env');

const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN || '';
const folderName = process.env.ZENOS_OFFSITE_BACKUP_FOLDER || 'Zenos Etla Offsite Backups';

if (!clientId || !clientSecret || !refreshToken) throw new Error('Google OAuth credentials are incomplete');

const oauth = new google.auth.OAuth2(clientId, clientSecret);
oauth.setCredentials({ refresh_token: refreshToken });
const drive = google.drive({ version: 'v3', auth: oauth });
const folderMime = 'application/vnd.google-apps.folder';

function escapeQuery(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function folderId() {
  const listed = await drive.files.list({
    q: `name='${escapeQuery(folderName)}' and mimeType='${folderMime}' and trashed=false`,
    fields: 'files(id,name,createdTime)',
    orderBy: 'createdTime asc',
    pageSize: 10,
  });
  const existing = listed.data.files?.find(file => file.id)?.id;
  if (existing) return existing;
  const created = await drive.files.create({
    requestBody: { name: folderName, mimeType: folderMime },
    fields: 'id',
  });
  if (!created.data.id) throw new Error('Drive did not return an offsite folder id');
  return created.data.id;
}

function latestEncryptedFiles() {
  const specs = [
    { dir: '/var/backups/zenos-runtime', match: /^zenos-runtime-.*\.json\.enc$/ },
    { dir: '/var/backups/zenos-memory', match: /^zenos-memory-.*\.json\.enc$/ },
  ];
  return specs.flatMap(spec => {
    if (!existsSync(spec.dir)) return [];
    const latest = readdirSync(spec.dir).filter(name => spec.match.test(name)).sort().at(-1);
    return latest ? [path.join(spec.dir, latest)] : [];
  });
}

async function listBackups(parent) {
  const files = [];
  let pageToken;
  do {
    const page = await drive.files.list({
      q: `'${escapeQuery(parent)}' in parents and trashed=false`,
      fields: 'nextPageToken,files(id,name,createdTime,size,md5Checksum)',
      orderBy: 'createdTime desc',
      pageSize: 1000,
      pageToken,
    });
    files.push(...(page.data.files || []));
    pageToken = page.data.nextPageToken || undefined;
  } while (pageToken);
  return files;
}

async function upload(parent, filePath) {
  const name = path.basename(filePath);
  const created = await drive.files.create({
    requestBody: {
      name,
      parents: [parent],
      appProperties: { service: 'zenos-offsite-backup', encrypted: 'true' },
    },
    media: { mimeType: 'application/octet-stream', body: createReadStream(filePath) },
    fields: 'id,name,size,md5Checksum,createdTime',
  });
  if (!created.data.id || created.data.name !== name || Number(created.data.size || 0) <= 0) {
    throw new Error(`Drive upload verification failed for ${name}`);
  }
  return created.data;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function verifyRemote(fileId, localPath) {
  const downloaded = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' },
  );
  const local = readFileSync(localPath);
  const remote = Buffer.from(downloaded.data);
  if (local.length !== remote.length || sha256(local) !== sha256(remote)) {
    throw new Error(`Offsite read-back verification failed for ${path.basename(localPath)}`);
  }
  return { name: path.basename(localPath), bytes: local.length, sha256: sha256(local) };
}

async function main() {
  const parent = await folderId();
  const remote = await listBackups(parent);
  const byName = new Map(remote.filter(file => file.id && file.name).map(file => [file.name, file]));
  const uploaded = [];
  const verified = [];
  for (const local of latestEncryptedFiles()) {
    const name = path.basename(local);
    let remoteFile = byName.get(name);
    if (!remoteFile) {
      remoteFile = await upload(parent, local);
      uploaded.push(remoteFile.name);
    }
    verified.push(await verifyRemote(remoteFile.id, local));
  }
  console.log(JSON.stringify({
    ok: true,
    folder: folderName,
    mode: 'append-only',
    uploaded,
    verified,
  }));
}

main().catch(error => {
  console.error(JSON.stringify({ ok: false, service: 'zenos-offsite-backup', error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
