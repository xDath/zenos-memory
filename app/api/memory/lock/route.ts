import { NextRequest } from 'next/server';
import { z } from 'zod';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { errorResponse, requestId } from '../../../lib/errors';
import { jsonResponse } from '../../../lib/http';
import { getMemoryEngine } from '../../../lib/memory-engine';

const AcquireSchema = z.object({
  action: z.literal('acquire').optional().default('acquire'),
  resource: z.string().trim().min(1).max(160),
  owner: z.string().trim().min(1).max(160),
  namespace: z.string().optional().default('zenos'),
  ttl_ms: z.number().int().min(5_000).max(300_000).optional().default(30_000),
});
const RenewSchema = z.object({
  action: z.literal('renew'),
  token: z.string().uuid(),
  owner: z.string().trim().min(1).max(160),
  namespace: z.string().optional().default('zenos'),
  resource: z.string().trim().min(1).max(160),
  ttl_ms: z.number().int().min(5_000).max(300_000).optional().default(30_000),
});
const ReleaseSchema = z.object({
  action: z.literal('release'),
  token: z.string().uuid(),
  owner: z.string().trim().min(1).max(160),
  namespace: z.string().optional().default('zenos'),
  resource: z.string().trim().min(1).max(160),
});

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    const body = await request.json();
    const action = typeof body?.action === 'string' ? body.action : 'acquire';
    const engine = getMemoryEngine();

    if (action === 'renew') {
      const parsed = RenewSchema.parse(body);
      const lease = await engine.renewLease(
        parsed.token,
        parsed.owner,
        parsed.ttl_ms,
        parsed.namespace,
        parsed.resource,
      );
      return jsonResponse({ success: Boolean(lease), lease, request_id: id }, {
        status: lease ? 200 : 409,
        requestId: id,
      });
    }
    if (action === 'release') {
      const parsed = ReleaseSchema.parse(body);
      const released = await engine.releaseLease(
        parsed.token,
        parsed.owner,
        parsed.namespace,
        parsed.resource,
      );
      return jsonResponse({ success: released, released, request_id: id }, {
        status: released ? 200 : 404,
        requestId: id,
      });
    }

    const parsed = AcquireSchema.parse(body);
    const lease = await engine.acquireLease(parsed.resource, parsed.owner, parsed.namespace, parsed.ttl_ms);
    return jsonResponse({
      success: Boolean(lease),
      acquired: Boolean(lease),
      lease,
      request_id: id,
    }, { status: lease ? 201 : 409, requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}

export async function GET(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    const namespace = new URL(request.url).searchParams.get('namespace') || undefined;
    const leases = await getMemoryEngine().listLeases(namespace);
    return jsonResponse({ success: true, leases, count: leases.length, request_id: id }, { requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
