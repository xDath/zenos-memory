import { NextRequest } from 'next/server';
import {
  AuthScope,
  authenticateTokenExchange,
  issueEtlaToken,
  issueEtlaTokenFromKeyring,
  memorySigningKeyring,
  unauthorizedResponse,
} from '../../lib/auth';
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
    const keyring = memorySigningKeyring();
    if (!keyring) throw new Error('Zenos token exchange is not configured');
    if (!await authenticateTokenExchange(request)) return unauthorizedResponse();

    const subjectHeader = request.headers.get('x-etla-client-id')?.trim() || 'zenos-client';
    const subject = /^[a-zA-Z0-9._:-]{2,96}$/.test(subjectHeader) ? subjectHeader : 'zenos-client';
    const ttlMs = 15 * 60_000;
    const issued = keyring.explicit
      ? issueEtlaTokenFromKeyring(keyring, {
          ttlMs,
          subject,
          scopes: requestedScopes(request),
        })
      : {
          token: issueEtlaToken(keyring.keys.get(keyring.activeKid) || '', {
            ttlMs,
            subject,
            scopes: requestedScopes(request),
          }),
          kid: keyring.activeKid,
        };

    return Response.json({
      success: true,
      token: issued.token,
      token_type: 'Bearer',
      kid: issued.kid,
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
