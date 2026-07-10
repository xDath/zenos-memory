import { NextRequest } from 'next/server';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { createDriveStore, hasDriveConfiguration } from '../../../lib/drive';
import { errorResponse, requestId } from '../../../lib/errors';
import { jsonResponse } from '../../../lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    if (!hasDriveConfiguration()) {
      return jsonResponse({ success: true, configured: false, files: [], request_id: id }, { requestId: id });
    }
    const files = (await createDriveStore().listFilesInFolder()).map(file => ({
      id: file.id,
      name: file.name,
      mime_type: file.mimeType,
      modified_at: file.modifiedTime,
      size: file.size,
    }));
    return jsonResponse({ success: true, configured: true, files, count: files.length, request_id: id }, { requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
