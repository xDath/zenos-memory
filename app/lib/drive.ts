import { google } from 'googleapis';
import * as fs from 'fs/promises';
import * as path from 'path';

interface DriveConfig {
  folderId: string;
  credentials: any;
}

export class GoogleDriveMemoryStore {
  private drive: any;
  private folderId: string;
  private memoriesFileName = 'zenos-memories.json';
  private fileId: string | null = null;

  constructor(config: DriveConfig) {
    const auth = new google.auth.GoogleAuth({
      credentials: config.credentials,
      scopes: ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive'],
    });
    this.drive = google.drive({ version: 'v3', auth });
    this.folderId = config.folderId;
  }

  private async getOrCreateMemoriesFile(): Promise<string> {
    if (this.fileId) return this.fileId;

    try {
      // Search for existing file
      const res = await this.drive.files.list({
        supportsAllDrives: true,
        q: `name='${this.memoriesFileName}' and '${this.folderId}' in parents and trashed=false`,
        fields: 'files(id, name)',
        pageSize: 1,
      });

      if (res.data.files && res.data.files.length > 0) {
        this.fileId = res.data.files[0].id;
        return this.fileId!;
      }

      // Create new file (may fail due to quota on personal Drive)
      try {
        const createRes = await this.drive.files.create({
          supportsAllDrives: true,
          requestBody: {
            name: this.memoriesFileName,
            parents: [this.folderId],
            mimeType: 'application/json',
          },
          media: {
            mimeType: 'application/json',
            body: JSON.stringify([]),
          },
          fields: 'id',
        });
        this.fileId = createRes.data.id;
      } catch (createErr: any) {
        console.error('Create failed (common on personal Drive):', createErr?.message);
        throw new Error(
          'Could not create memories file. Please manually create "zenos-memories.json" with content "[]" in the folder using your personal account, share the FILE (not just folder) with the service account as Editor, then retry.'
        );
      }
      return this.fileId!;
    } catch (error: any) {
      console.error('Drive file init error:', error?.message || error);
      if (error?.message?.includes('quota') || error?.code === 403) {
        throw new Error(
          'Service Account quota error. ' +
          'Please manually create a file named "zenos-memories.json" containing exactly "[]" (empty array) ' +
          'inside your shared folder using the OWNER account, then share THAT FILE specifically with the service account (Editor). ' +
          'After that, try again.'
        );
      }
      throw new Error('Failed to initialize memories. Check service account sharing and Drive permissions: ' + (error?.message || error));
    }
  }

  async readAll(): Promise<any[]> {
    try {
      const fileId = await this.getOrCreateMemoriesFile();
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

  async writeAll(memories: any[]): Promise<void> {
    try {
      const fileId = await this.getOrCreateMemoriesFile();
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
      q: `'${this.folderId}' in parents and trashed=false`,
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
  private filePath: string;

  constructor() {
    const dataDir = process.env.LOCAL_MEMORY_DIR || '/tmp/zenos-memory';
    this.filePath = path.join(dataDir, 'memories.json');
  }

  private async ensureDir() {
    const dir = path.dirname(this.filePath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch {}
  }

  async readAll(): Promise<any[]> {
    await this.ensureDir();
    try {
      const data = await fs.readFile(this.filePath, 'utf8');
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  async writeAll(memories: any[]): Promise<void> {
    await this.ensureDir();
    await fs.writeFile(this.filePath, JSON.stringify(memories, null, 2));
  }
}
