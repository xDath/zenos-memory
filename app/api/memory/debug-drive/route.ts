import { NextRequest, NextResponse } from 'next/server';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';

export async function GET(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();

  const results: Record<string, any> = {
    env: {
      USE_LOCAL_STORE: process.env.USE_LOCAL_STORE || '(not set)',
      HAS_GOOGLE_KEY: !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
      HAS_GOOGLE_FILE: !!process.env.GOOGLE_SERVICE_ACCOUNT_FILE,
      HAS_FOLDER_ID: !!process.env.ZENOS_MEMORY_DRIVE_FOLDER_ID,
      FOLDER_ID: process.env.ZENOS_MEMORY_DRIVE_FOLDER_ID || '(not set)',
    },
    drive_test: null,
    error: null,
  };

  try {
    const { google } = await import('googleapis');
    const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    const folderId = process.env.ZENOS_MEMORY_DRIVE_FOLDER_ID;

    if (!keyJson || !folderId) {
      results.error = 'Missing GOOGLE_SERVICE_ACCOUNT_KEY or FOLDER_ID';
      return NextResponse.json(results);
    }

    const credentials = JSON.parse(keyJson);
    results.service_account_email = credentials.client_email;

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive'],
    });
    const drive = google.drive({ version: 'v3', auth });

    // Test 1: List files in folder
    try {
      const listRes = await drive.files.list({
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        q: `'${folderId}' in parents and trashed=false`,
        fields: 'files(id, name, mimeType, createdTime)',
        pageSize: 10,
      });
      results.drive_test = {
        list_ok: true,
        files_found: (listRes.data.files || []).length,
        files: (listRes.data.files || []).map((f: any) => ({ id: f.id, name: f.name, type: f.mimeType })),
      };
    } catch (e: any) {
      results.drive_test = { list_ok: false, list_error: e.message || String(e) };
    }

    // Test 2: Create a tiny test file
    try {
      const createRes = await drive.files.create({
        supportsAllDrives: true,
        requestBody: {
          name: 'zenos-drive-test.txt',
          parents: [folderId],
          mimeType: 'text/plain',
        },
        media: {
          mimeType: 'text/plain',
          body: 'test ' + new Date().toISOString(),
        },
        fields: 'id,name',
      });
      results.create_test = { ok: true, file_id: createRes.data.id, name: createRes.data.name };

      // Cleanup: delete test file
      await drive.files.delete({ fileId: createRes.data.id!, supportsAllDrives: true });
      results.create_test.cleaned = true;
    } catch (e: any) {
      results.create_test = { ok: false, error: e.message || String(e), code: e.code, errors: e.errors };
    }

  } catch (e: any) {
    results.error = e.message || String(e);
  }

  return NextResponse.json(results);
}
