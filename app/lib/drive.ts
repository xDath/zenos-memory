import { google } from 'googleapis';
import * as fs from 'fs/promises';
import * as path from 'path';

interface DriveConfig {
  folderId: string;
  credentials: any;
}

export class GoogleDriveMemoryStore {
  private drive: any;
  private rootFolderId: string;
  private memoriesFileName = 'zenos-memories.json';
  private fileIds = new Map<string, string>();

  constructor(config: DriveConfig) {
    const auth = new google.auth.GoogleAuth({
      credentials: config.credentials,
      scopes: ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive'],
    });
    this.drive = google.drive({ version: 'v3', auth });
    this.rootFolderId = config.folderId;
  }

  private async ensureNamespaceFolder(namespace: string): Promise<string> {
    const folderName = `namespace-${namespace}`;
    const res = await this.drive.files.list({
      supportsAllDrives: true,
      q: `name='${folderName}' and '${this.rootFolderId}' in parents and trashed=false and mimeType='application/vnd.google-apps.folder'`,
      fields: 'files(id)',
      pageSize: 1,
    });

    if (res.data.files && res.data.files.length > 0) {
      return res.data.files[0].id;
    }

    const createRes = await this.drive.files.create({
      supportsAllDrives: true,
      requestBody: {
        name: folderName,
        parents: [this.rootFolderId],
        mimeType: 'application/vnd.google-apps.folder',
      },
      fields: 'id',
    });
    return createRes.data.id;
  }

  private async ensureChildFolder(parentId: string, name: string): Promise<string> {
    const res = await this.drive.files.list({
      supportsAllDrives: true,
      q: `name='${name}' and '${parentId}' in parents and trashed=false and mimeType='application/vnd.google-apps.folder'`,
      fields: 'files(id)',
      pageSize: 1,
    });
    if (res.data.files && res.data.files.length > 0) return res.data.files[0].id;
    const createRes = await this.drive.files.create({
      supportsAllDrives: true,
      requestBody: { name, parents: [parentId], mimeType: 'application/vnd.google-apps.folder' },
      fields: 'id',
    });
    return createRes.data.id;
  }

  private async getOrCreateMemoriesFile(namespace = 'zenos'): Promise<string> {
    const cached = this.fileIds.get(namespace);
    if (cached) return cached;

    const namespaceFolder = await this.ensureNamespaceFolder(namespace);
    await this.ensureChildFolder(namespaceFolder, 'topics');
    await this.ensureChildFolder(namespaceFolder, 'compactions');
    await this.ensureChildFolder(namespaceFolder, 'indexes');
    const parentFolder = await this.ensureChildFolder(namespaceFolder, 'memories');

    const res = await this.drive.files.list({
      supportsAllDrives: true,
      q: `name='${this.memoriesFileName}' and '${parentFolder}' in parents and trashed=false`,
      fields: 'files(id, name)',
      pageSize: 1,
    });

    if (res.data.files && res.data.files.length > 0) {
      const id = res.data.files[0].id;
      this.fileIds.set(namespace, id);
      return id;
    }

    const createRes = await this.drive.files.create({
      supportsAllDrives: true,
      requestBody: {
        name: this.memoriesFileName,
        parents: [parentFolder],
        mimeType: 'application/json',
      },
      media: {
        mimeType: 'application/json',
        body: JSON.stringify([]),
      },
      fields: 'id',
    });
    const id = createRes.data.id;
    this.fileIds.set(namespace, id);
    return id;
  }

  async readAll(namespace?: string): Promise<any[]> {
    try {
      const fileId = await this.getOrCreateMemoriesFile(namespace || 'zenos');
      const res = await this.drive.files.get({
        supportsAllDrives: true,
        fileId,
        alt: 'media',
      });
      const content = res.data || '[]';
      return typeof content === 'string' ? JSON.parse(content) : content;
    } catch (error) {
      console.error('Drive read error:', error);
      return [];
    }
  }

  async writeAll(memories: any[], namespace = 'zenos'): Promise<void> {
    try {
      const fileId = await this.getOrCreateMemoriesFile(namespace);
      await this.drive.files.update({
        supportsAllDrives: true,
        fileId,
        media: {
          mimeType: 'application/json',
          body: JSON.stringify(memories, null, 2),
        },
      });
    } catch (error) {
      console.error('Drive write error:', error);
      throw new Error('Failed to write memories. Check quota and permissions');
    }
  }

  async listFilesInFolder(): Promise<any[]> {
    const res = await this.drive.files.list({
        supportsAllDrives: true,
      q: `'${this.rootFolderId}' in parents and trashed=false`,
      fields: 'files(id, name, mimeType, createdTime)',
    });
    return res.data.files || [];
  }
}

// Factory for Drive
export function createDriveStore(): GoogleDriveMemoryStore {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
  const folderId = process.env.ZENOS_MEMORY_DRIVE_FOLDER_ID;

  if (!folderId) {
    throw new Error('Missing ZENOS_MEMORY_DRIVE_FOLDER_ID in env');
  }

  let credentials: any;

  if (keyFile) {
    try {
      const fileContent = require('fs').readFileSync(keyFile, 'utf8');
      credentials = JSON.parse(fileContent);
    } catch (e) {
      throw new Error('Failed to read or parse GOOGLE_SERVICE_ACCOUNT_FILE');
    }
  } else if (keyJson) {
    try {
      credentials = JSON.parse(keyJson);
    } catch {
      throw new Error('Invalid GOOGLE_SERVICE_ACCOUNT_KEY JSON');
    }
  } else {
    throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_KEY or GOOGLE_SERVICE_ACCOUNT_FILE');
  }

  return new GoogleDriveMemoryStore({ folderId, credentials });
}

// Local file fallback for development/testing
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
