import { NextRequest } from 'next/server';
import { AuthScope, authenticateTokenExchange, issueEtlaToken, unauthorizedResponse } from '../../lib/auth';
import { errorResponse, requestId } from '../../lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function requestedScopes(request: NextRequest): AuthScope[] {
  const requested = (request.headers.get('x-etla-requested-scopes') || 'memory:read memory:write')
    .split(/[\s,]+/)
    .filter(Boolean);
  const allowed = new Set<AuthScope>(['memory:read', 'memory:write']);
  if (process.env.ZENOS_MEMORY_ALLOW_ADMIN_TOKEN_EXCHANGE === 'true') allowed.add('memory:admin');
  const scopes = requested.filter((scope): scope is AuthScope => allowed.has(scope as AuthScope));
  return scopes.length ? [...new Set(scopes)] : ['memory:read'];
}

export async function POST(request: NextRequest) {
  const id = requestId(request);
  try {
    const secret = process.env.ETLA_MASTER_SECRET?.trim() || process.env.ZENOS_MEMORY_SECRET?.trim();
    if (!secret) throw new Error('Zenos token exchange is not configured');
    if (!await authenticateTokenExchange(request)) return unauthorizedResponse();

    const subjectHeader = request.headers.get('x-etla-client-id')?.trim() || 'zenos-client';
    const subject = /^[a-zA-Z0-9._:-]{2,96}$/.test(subjectHeader) ? subjectHeader : 'zenos-client';
    const ttlMs = 15 * 60_000;
    const token = issueEtlaToken(secret, {
      ttlMs,
      subject,
      scopes: requestedScopes(request),
    });

    return Response.json({
      success: true,
      token,
      token_type: 'Bearer',
      expires_in: Math.floor(ttlMs / 1000),
      scopes: requestedScopes(request),
      request_id: id,
    }, {
      headers: {
        'cache-control': 'no-store',
        'x-request-id': id,
      },
    });
  } catch (error) {
    return errorResponse(error, id);
  }
}
