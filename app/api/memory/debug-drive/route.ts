import { NextRequest, NextResponse } from 'next/server';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';
import { createDriveStore } from '../../../lib/drive';

export async function GET(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();

  const results: Record<string, any> = {
    env: {
      USE_LOCAL_STORE: process.env.USE_LOCAL_STORE || '(not set)',
      HAS_GOOGLE_KEY: !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
      HAS_GOOGLE_FILE: !!process.env.GOOGLE_SERVICE_ACCOUNT_FILE,
      HAS_OAUTH_CLIENT_ID: !!process.env.GOOGLE_OAUTH_CLIENT_ID,
      HAS_OAUTH_CLIENT_SECRET: !!process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      HAS_OAUTH_REFRESH_TOKEN: !!process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
      DRIVE_STRUCTURED: process.env.ZENOS_MEMORY_DRIVE_STRUCTURED || '(not set)',
      HAS_FOLDER_ID: !!process.env.ZENOS_MEMORY_DRIVE_FOLDER_ID,
      FOLDER_ID: process.env.ZENOS_MEMORY_DRIVE_FOLDER_ID || '(not set)',
    },
    store_test: null,
    error: null,
  };

  try {
    const store: any = createDriveStore();
    results.files = await store.listFilesInFolder();

    const marker = [{
      id: 'debug-' + Date.now(),
      type: 'fact',
      content: 'debug write',
      namespace: 'zenos-debug',
      metadata: { confidence: 1, tags: ['debug'], version: 1, importance: 1, related_ids: [] },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }];
    await store.writeAll(marker, 'zenos-debug');
    const readBack = await store.readAll('zenos-debug');
    results.store_test = { write_ok: true, read_count: Array.isArray(readBack) ? readBack.length : null, readBack };
  } catch (e: any) {
    results.error = {
      message: e.message || String(e),
      code: e.code,
      errors: e.errors,
      stack: e.stack,
    };
  }

  return NextResponse.json(results);
}
