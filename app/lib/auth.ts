import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createDriveStoreIfConfigured } from './drive';

export type AuthScope = 'memory:read' | 'memory:write' | 'memory:admin';

interface TokenClaims {
  ver: 1;
  sub: string;
  scopes: AuthScope[];
  iat: number;
  exp: number;
  jti: string;
}

const TOKEN_PREFIX = 'zm1';
const MAX_CLOCK_SKEW_MS = 60_000;
const NONCE_TTL_MS = 2 * 60_000;
const usedNonces = new Map<string, number>();

function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(a) || !/^[a-f0-9]{64}$/i.test(b)) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

function safeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function parseBase64urlJson<T>(input: string): T | null {
  try {
    return JSON.parse(Buffer.from(input, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

function cleanExpiredNonces(now: number): void {
  for (const [nonce, expires] of usedNonces) {
    if (expires <= now) usedNonces.delete(nonce);
  }
}

function claimNonce(nonce: string, now: number): boolean {
  cleanExpiredNonces(now);
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(nonce) || usedNonces.has(nonce)) return false;
  if (usedNonces.size >= 10_000) return false;
  usedNonces.set(nonce, now + NONCE_TTL_MS);
  return true;
}

function pathWithQuery(request: Request): string {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

function canonicalV2(request: Request, timestamp: number, nonce: string, bodyHash: string): string {
  return [
    'zenos-memory-signature-v2',
    String(timestamp),
    nonce,
    request.method.toUpperCase(),
    pathWithQuery(request),
    bodyHash,
  ].join('\n');
}

function verifySignatureV2(request: Request, secret: string, consumeNonce = true): boolean {
  const tsRaw = request.headers.get('x-etla-timestamp') || '';
  const nonce = request.headers.get('x-etla-nonce') || '';
  const signature = request.headers.get('x-etla-signature') || '';
  const bodyHash = request.headers.get('x-etla-content-sha256') || sha256('');
  const timestamp = Number(tsRaw);
  const now = Date.now();

  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > MAX_CLOCK_SKEW_MS) return false;
  if (!/^[a-f0-9]{64}$/i.test(bodyHash)) return false;
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(nonce)) return false;

  const expected = createHmac('sha256', secret)
    .update(canonicalV2(request, timestamp, nonce, bodyHash), 'utf8')
    .digest('hex');
  if (!safeEqualHex(signature, expected)) return false;
  return !consumeNonce || claimNonce(nonce, now);
}

function verifyLegacySignature(request: Request, secret: string): boolean {
  if (process.env.ZENOS_MEMORY_ALLOW_LEGACY_HMAC !== 'true') return false;
  const tsRaw = request.headers.get('x-etla-timestamp') || '';
  const signature = request.headers.get('x-etla-signature') || '';
  const timestamp = Number(tsRaw);
  if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() - timestamp) > MAX_CLOCK_SKEW_MS) return false;
  const payload = `${timestamp}:${request.method.toUpperCase()}:${pathWithQuery(request)}`;
  const expected = createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
  return safeEqualHex(signature, expected);
}

function scopeIncludes(granted: AuthScope[], required: AuthScope): boolean {
  if (granted.includes('memory:admin')) return true;
  if (required === 'memory:read' && granted.includes('memory:write')) return true;
  return granted.includes(required);
}

function requiredScope(request: Request): AuthScope {
  const path = new URL(request.url).pathname;
  const method = request.method.toUpperCase();
  if (/\/(?:backup|restore|debug-drive|benchmark|ab-eval|eval|maintain|scheduler|merge|lock|agent\/test-llm)(?:\/|$)/.test(path)) return 'memory:admin';
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return 'memory:read';
  if (/\/(?:recall|hybrid-recall|answer|bootstrap|authenticated-status|graph-query|vector|embed|auto-tag|mutation-plan|conflicts|resolve-conflict)(?:\/|$)/.test(path)) return 'memory:read';
  return 'memory:write';
}

function tokenFromRequest(request: Request): string {
  const explicit = request.headers.get('x-etla-token')?.trim();
  if (explicit) return explicit;
  const authorization = request.headers.get('authorization')?.trim() || '';
  if (/^Bearer\s+zm1\./i.test(authorization)) return authorization.replace(/^Bearer\s+/i, '');
  return '';
}

export function issueEtlaToken(
  secret: string,
  options: {
    ttlMs?: number;
    subject?: string;
    scopes?: AuthScope[];
  } = {},
): string {
  const now = Date.now();
  const ttl = Math.max(60_000, Math.min(options.ttlMs || 15 * 60_000, 60 * 60_000));
  const claims: TokenClaims = {
    ver: 1,
    sub: options.subject || 'zenos-client',
    scopes: options.scopes || ['memory:read', 'memory:write'],
    iat: now,
    exp: now + ttl,
    jti: randomUUID(),
  };
  const encoded = base64url(JSON.stringify(claims));
  const signature = createHmac('sha256', secret).update(`${TOKEN_PREFIX}.${encoded}`, 'utf8').digest('hex');
  return `${TOKEN_PREFIX}.${encoded}.${signature}`;
}

export function verifyEtlaToken(token: string, secret: string, required: AuthScope = 'memory:read'): TokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
  const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`, 'utf8').digest('hex');
  if (!safeEqualHex(parts[2], expected)) return null;
  const claims = parseBase64urlJson<TokenClaims>(parts[1]);
  if (!claims || claims.ver !== 1 || !Array.isArray(claims.scopes)) return null;
  const now = Date.now();
  if (!Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)) return null;
  if (claims.iat > now + MAX_CLOCK_SKEW_MS || claims.exp <= now || claims.exp - claims.iat > 60 * 60_000) return null;
  if (!scopeIncludes(claims.scopes, required)) return null;
  return claims;
}

export function verifyEtlaSignature(request: Request, secret: string): boolean {
  return verifySignatureV2(request, secret) || verifyLegacySignature(request, secret);
}

export function validateApiKey(request: Request): boolean {
  const production = process.env.NODE_ENV === 'production';
  const secret = process.env.ETLA_MASTER_SECRET?.trim() || process.env.ZENOS_MEMORY_SECRET?.trim();
  const required = requiredScope(request);

  if (secret) {
    const token = tokenFromRequest(request);
    if (token && verifyEtlaToken(token, secret, required)) return true;

    const safeDirectSignature = !production
      && (request.method === 'GET' || request.method === 'HEAD');
    if (safeDirectSignature && verifyEtlaSignature(request, secret)) return true;
  }

  const apiKey = process.env.ZENOS_MEMORY_API_KEY?.trim();
  const staticAllowed = !production || process.env.ZENOS_MEMORY_ALLOW_STATIC_API_KEY === 'true';
  if (apiKey && staticAllowed) {
    const authorization = request.headers.get('authorization') || '';
    const provided = authorization.replace(/^Bearer\s+/i, '').trim() || request.headers.get('x-api-key')?.trim() || '';
    if (provided && safeEqualString(provided, apiKey)) return true;
  }

  if (!production && process.env.ZENOS_MEMORY_ALLOW_INSECURE_DEV === 'true') return true;
  return false;
}

export async function authenticateTokenExchange(request: Request): Promise<boolean> {
  const secret = process.env.ETLA_MASTER_SECRET?.trim() || process.env.ZENOS_MEMORY_SECRET?.trim();
  if (!secret) return false;
  if (verifyLegacySignature(request, secret)) return true;
  if (!verifySignatureV2(request, secret, false)) return false;

  const nonce = request.headers.get('x-etla-nonce') || '';
  const cloudMode = process.env.ZENOS_MEMORY_STORAGE_MODE === 'drive-events';
  if (cloudMode) {
    const drive = createDriveStoreIfConfigured();
    if (!drive) return false;
    return drive.claimCloudNonce(nonce, NONCE_TTL_MS);
  }
  return claimNonce(nonce, Date.now());
}

export function unauthorizedResponse(): Response {
  return Response.json(
    {
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'A valid scoped Zenos token is required',
      },
    },
    {
      status: 401,
      headers: {
        'cache-control': 'no-store',
        'www-authenticate': 'Bearer realm="zenos-memory"',
      },
    },
  );
}

export function sha256Body(body: string | Buffer): string {
  return sha256(body);
}
