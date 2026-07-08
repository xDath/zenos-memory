import { google } from 'googleapis';
import * as fs from 'fs/promises';
import { readFileSync } from 'fs';
import * as path from 'path';

interface DriveConfig {
  folderId: string;
  credentials?: any;
  oauth?: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  };
  structured?: boolean;
}

type JsonKind = 'memories' | 'entities' | 'relationships' | 'profile' | 'audit' | 'compactions' | 'indexes';

const STRUCTURED_KINDS: JsonKind[] = ['memories', 'entities', 'relationships', 'profile', 'audit', 'compactions', 'indexes'];

function escapeDriveQuery(value: string): string {
  return value.replace(/'/g, "\\'");
}

export class GoogleDriveMemoryStore {
  private drive: any;
  private rootFolderId: string;
  private fileIds = new Map<string, string>();
  private folderIds = new Map<string, string>();
  private canCreate: boolean;
  private structured: boolean;

  constructor(config: DriveConfig) {
    if (config.oauth) {
      const oauthClient = new google.auth.OAuth2(config.oauth.clientId, config.oauth.clientSecret);
      oauthClient.setCredentials({ refresh_token: config.oauth.refreshToken });
      this.drive = google.drive({ version: 'v3', auth: oauthClient });
      this.canCreate = true;
    } else {
      const auth = new google.auth.GoogleAuth({
        credentials: config.credentials,
        scopes: ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive'],
      });
      this.drive = google.drive({ version: 'v3', auth });
      this.canCreate = false;
    }

    this.rootFolderId = config.folderId;
    this.structured = config.structured ?? !!config.oauth;
  }

  private async findChild(parentId: string, name: string, mimeType?: string): Promise<string | null> {
    const escapedName = escapeDriveQuery(name);
    const mimeClause = mimeType ? ` and mimeType='${mimeType}'` : '';
    const res = await this.drive.files.list({
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      q: `name='${escapedName}' and '${parentId}' in parents and trashed=false${mimeClause}`,
      fields: 'files(id, name, mimeType)',
      pageSize: 1,
    });
    return res.data.files?.[0]?.id || null;
  }

  private async ensureFolder(parentId: string, name: string): Promise<string> {
    const cacheKey = `${parentId}:${name}`;
    const cached = this.folderIds.get(cacheKey);
    if (cached) return cached;

    const existing = await this.findChild(parentId, name, 'application/vnd.google-apps.folder');
    if (existing) {
      this.folderIds.set(cacheKey, existing);
      return existing;
    }

    if (!this.canCreate) {
      throw new Error(`Drive folder "${name}" not found and current auth cannot create folders. Use OAuth mode or pre-create it.`);
    }

    const createRes = await this.drive.files.create({
      supportsAllDrives: true,
      requestBody: {
        name,
        parents: [parentId],
        mimeType: 'application/vnd.google-apps.folder',
      },
      fields: 'id',
    });
    const id = createRes.data.id;
    this.folderIds.set(cacheKey, id);
    return id;
  }

  private async ensureJsonFile(parentId: string, name: string, initial: any): Promise<string> {
    const cacheKey = `${parentId}:${name}`;
    const cached = this.fileIds.get(cacheKey);
    if (cached) return cached;

    const existing = await this.findChild(parentId, name, 'application/json');
    if (existing) {
      this.fileIds.set(cacheKey, existing);
      return existing;
    }

    if (!this.canCreate) {
      throw new Error(`Drive file "${name}" not found and current auth cannot create files. Use OAuth mode or pre-create it.`);
    }

    const createRes = await this.drive.files.create({
      supportsAllDrives: true,
      requestBody: {
        name,
        parents: [parentId],
        mimeType: 'application/json',
      },
      media: {
        mimeType: 'application/json',
        body: JSON.stringify(initial, null, 2),
      },
      fields: 'id',
    });
    const id = createRes.data.id;
    this.fileIds.set(cacheKey, id);
    return id;
  }

  private async getStructuredRoot(): Promise<string> {
    return this.ensureFolder(this.rootFolderId, 'zenos-memory');
  }

  private async getNamespaceFolder(namespace = 'zenos'): Promise<string> {
    const root = await this.getStructuredRoot();
    const namespaces = await this.ensureFolder(root, 'namespaces');
    return this.ensureFolder(namespaces, namespace);
  }

  private async getStructuredFile(namespace = 'zenos', kind: JsonKind = 'memories'): Promise<string> {
    const namespaceFolder = await this.getNamespaceFolder(namespace);
    for (const item of STRUCTURED_KINDS) {
      const initial = item === 'profile' ? {} : [];
      if (item === kind) continue;
      void this.ensureJsonFile(namespaceFolder, `${item}.json`, initial).catch(() => undefined);
    }
    const initial = kind === 'profile' ? {} : [];
    return this.ensureJsonFile(namespaceFolder, `${kind}.json`, initial);
  }

  private async getFlatMemoriesFile(namespace = 'zenos'): Promise<string> {
    const cacheKey = `flat:${namespace}`;
    const cached = this.fileIds.get(cacheKey);
    if (cached) return cached;

    const candidates = [`zenos-memories-${namespace}.json`, 'zenos-memories.json'];
    for (const fileName of candidates) {
      const existing = await this.findChild(this.rootFolderId, fileName, 'application/json');
      if (existing) {
        this.fileIds.set(cacheKey, existing);
        return existing;
      }
    }

    if (this.canCreate) {
      const id = await this.ensureJsonFile(this.rootFolderId, `zenos-memories-${namespace}.json`, []);
      this.fileIds.set(cacheKey, id);
      return id;
    }

    throw new Error(
      `No memories file found in Drive folder ${this.rootFolderId} for namespace "${namespace}". ` +
      `Service accounts cannot create files. Use OAuth mode or pre-create zenos-memories-${namespace}.json with content [].`
    );
  }

  private async getMemoriesFile(namespace = 'zenos'): Promise<string> {
    if (this.structured && this.canCreate) {
      return this.getStructuredFile(namespace, 'memories');
    }
    return this.getFlatMemoriesFile(namespace);
  }

  async readJsonFile(namespace = 'zenos', kind: JsonKind = 'memories'): Promise<any> {
    try {
      const fileId = this.structured && this.canCreate
        ? await this.getStructuredFile(namespace, kind)
        : await this.getMemoriesFile(namespace);
      const res = await this.drive.files.get({ supportsAllDrives: true, fileId, alt: 'media' });
      const content = res.data || (kind === 'profile' ? '{}' : '[]');
      return typeof content === 'string' ? JSON.parse(content) : content;
    } catch (error) {
      console.error(`Drive ${kind} read error:`, error);
      return kind === 'profile' ? {} : [];
    }
  }

  async writeJsonFile(namespace = 'zenos', kind: JsonKind = 'memories', value: any): Promise<void> {
    try {
      const fileId = this.structured && this.canCreate
        ? await this.getStructuredFile(namespace, kind)
        : await this.getMemoriesFile(namespace);
      await this.drive.files.update({
        supportsAllDrives: true,
        fileId,
        media: {
          mimeType: 'application/json',
          body: JSON.stringify(value, null, 2),
        },
      });
    } catch (error: any) {
      console.error(`Drive ${kind} write error:`, error);
      const details = error?.errors ? JSON.stringify(error.errors) : (error?.message || String(error));
      throw new Error(`Failed to write ${kind}. ${details}`);
    }
  }

  async readAll(namespace?: string): Promise<any[]> {
    return this.readJsonFile(namespace || 'zenos', 'memories');
  }

  async writeAll(memories: any[], namespace = 'zenos'): Promise<void> {
    await this.writeJsonFile(namespace, 'memories', memories);
  }

  async listFilesInFolder(): Promise<any[]> {
    const res = await this.drive.files.list({
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      q: `'${this.rootFolderId}' in parents and trashed=false`,
      fields: 'files(id, name, mimeType, createdTime)',
    });
    return res.data.files || [];
  }
}

export function createDriveStore(): GoogleDriveMemoryStore {
  const folderId = process.env.ZENOS_MEMORY_DRIVE_FOLDER_ID;
  if (!folderId) throw new Error('Missing ZENOS_MEMORY_DRIVE_FOLDER_ID in env');

  const oauthClientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const oauthClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const oauthRefreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

  if (oauthClientId && oauthClientSecret && oauthRefreshToken) {
    return new GoogleDriveMemoryStore({
      folderId,
      structured: process.env.ZENOS_MEMORY_DRIVE_STRUCTURED !== 'false',
      oauth: {
        clientId: oauthClientId,
        clientSecret: oauthClientSecret,
        refreshToken: oauthRefreshToken,
      },
    });
  }

  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
  let credentials: any;

  if (keyFile) {
    try {
      const fileContent = readFileSync(keyFile, 'utf8');
      credentials = JSON.parse(fileContent);
    } catch {
      throw new Error('Failed to read or parse GOOGLE_SERVICE_ACCOUNT_FILE');
    }
  } else if (keyJson) {
    try {
      credentials = JSON.parse(keyJson);
    } catch {
      throw new Error('Invalid GOOGLE_SERVICE_ACCOUNT_KEY JSON');
    }
  } else {
    throw new Error('Missing Google Drive auth envs. Use OAuth envs or service account envs.');
  }

  return new GoogleDriveMemoryStore({ folderId, credentials, structured: false });
}

export class LocalFileMemoryStore {
  private dataDir: string;

  constructor() {
    this.dataDir = process.env.LOCAL_MEMORY_DIR || '/tmp/zenos-memory';
  }

  private filePath(namespace = 'zenos') {
    return path.join(this.dataDir, `namespace-${namespace}`, 'memories', 'zenos-memories.json');
  }

  private async ensureDir(namespace = 'zenos') {
    const dir = path.dirname(this.filePath(namespace));
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch {}
  }

  async readAll(namespace?: string): Promise<any[]> {
    await this.ensureDir(namespace || 'zenos');
    try {
      const data = await fs.readFile(this.filePath(namespace || 'zenos'), 'utf8');
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  async writeAll(memories: any[], namespace = 'zenos'): Promise<void> {
    await this.ensureDir(namespace);
    await fs.writeFile(this.filePath(namespace), JSON.stringify(memories, null, 2));
  }
}
