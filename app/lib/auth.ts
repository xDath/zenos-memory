import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createDriveStoreIfConfigured } from './drive';

export type AuthScope = 'memory:read' | 'memory:write' | 'memory:admin';

interface TokenClaims {
  ver: 1 | 2;
  sub: string;
  scopes: AuthScope[];
  iat: number;
  exp: number;
  jti: string;
}

const TOKEN_PREFIX = 'zm1';
const ROTATING_TOKEN_PREFIX = 'zm2';
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

export type MemorySigningKeyring = {
  activeKid: string;
  keys: Map<string, string>;
  explicit: boolean;
};

function parseSigningKeys(raw: string): Map<string, string> {
  const keys = new Map<string, string>();
  if (!raw.trim()) return keys;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [kid, value] of Object.entries(parsed)) {
      if (/^[a-zA-Z0-9._:-]{1,64}$/.test(kid) && typeof value === 'string' && value.length >= 32) keys.set(kid, value);
    }
    return keys;
  } catch {
    for (const entry of raw.split(',')) {
      const separator = entry.indexOf(':');
      if (separator <= 0) continue;
      const kid = entry.slice(0, separator).trim();
      const secret = entry.slice(separator + 1).trim();
      if (/^[a-zA-Z0-9._:-]{1,64}$/.test(kid) && secret.length >= 32) keys.set(kid, secret);
    }
    return keys;
  }
}

export function memorySigningKeyring(): MemorySigningKeyring | null {
  const explicitKeys = parseSigningKeys(process.env.ZENOS_MEMORY_SIGNING_KEYS || '');
  if (explicitKeys.size) {
    const requested = (process.env.ZENOS_MEMORY_ACTIVE_KID || '').trim();
    const activeKid = requested && explicitKeys.has(requested) ? requested : [...explicitKeys.keys()][0];
    return { activeKid, keys: explicitKeys, explicit: true };
  }
  const legacy = process.env.ZENOS_MEMORY_SECRET?.trim() || process.env.ETLA_MASTER_SECRET?.trim();
  if (!legacy) return null;
  return { activeKid: 'legacy', keys: new Map([['legacy', legacy]]), explicit: false };
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

function canonicalV3(request: Request, timestamp: number, nonce: string, bodyHash: string, kid: string): string {
  return [
    'zenos-memory-signature-v3',
    kid,
    String(timestamp),
    nonce,
    request.method.toUpperCase(),
    pathWithQuery(request),
    bodyHash,
  ].join('\n');
}

type SignatureFailureReason = 'timestamp' | 'body_hash' | 'nonce_format' | 'signature_mismatch' | 'nonce_replay_or_capacity';

function verifySignatureV2(
  request: Request,
  secret: string,
  consumeNonce = true,
  onFailure?: (reason: SignatureFailureReason) => void,
): boolean {
  const tsRaw = request.headers.get('x-etla-timestamp') || '';
  const nonce = request.headers.get('x-etla-nonce') || '';
  const signature = request.headers.get('x-etla-signature') || '';
  const bodyHash = request.headers.get('x-etla-content-sha256') || sha256('');
  const timestamp = Number(tsRaw);
  const now = Date.now();

  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > MAX_CLOCK_SKEW_MS) {
    onFailure?.('timestamp');
    return false;
  }
  if (!/^[a-f0-9]{64}$/i.test(bodyHash)) {
    onFailure?.('body_hash');
    return false;
  }
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(nonce)) {
    onFailure?.('nonce_format');
    return false;
  }

  const expected = createHmac('sha256', secret)
    .update(canonicalV2(request, timestamp, nonce, bodyHash), 'utf8')
    .digest('hex');
  if (!safeEqualHex(signature, expected)) {
    onFailure?.('signature_mismatch');
    return false;
  }
  if (!consumeNonce || claimNonce(nonce, now)) return true;
  onFailure?.('nonce_replay_or_capacity');
  return false;
}

function verifySignatureV3(
  request: Request,
  keyring: MemorySigningKeyring,
  consumeNonce = true,
  onFailure?: (reason: SignatureFailureReason) => void,
): boolean {
  const kid = request.headers.get('x-etla-kid')?.trim() || '';
  const secret = keyring.keys.get(kid);
  if (!secret) {
    onFailure?.('signature_mismatch');
    return false;
  }
  const tsRaw = request.headers.get('x-etla-timestamp') || '';
  const nonce = request.headers.get('x-etla-nonce') || '';
  const signature = request.headers.get('x-etla-signature') || '';
  const bodyHash = request.headers.get('x-etla-content-sha256') || sha256('');
  const timestamp = Number(tsRaw);
  const now = Date.now();
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > MAX_CLOCK_SKEW_MS) {
    onFailure?.('timestamp');
    return false;
  }
  if (!/^[a-f0-9]{64}$/i.test(bodyHash)) {
    onFailure?.('body_hash');
    return false;
  }
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(nonce)) {
    onFailure?.('nonce_format');
    return false;
  }
  const expected = createHmac('sha256', secret)
    .update(canonicalV3(request, timestamp, nonce, bodyHash, kid), 'utf8')
    .digest('hex');
  if (!safeEqualHex(signature, expected)) {
    onFailure?.('signature_mismatch');
    return false;
  }
  if (!consumeNonce || claimNonce(nonce, now)) return true;
  onFailure?.('nonce_replay_or_capacity');
  return false;
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
  if (/\/(?:recall|hybrid-recall|answer|bootstrap|cognitive-brief|authenticated-status|revision|graph-query|vector|embed|auto-tag|mutation-plan|conflicts)(?:\/|$)/.test(path)) return 'memory:read';
  return 'memory:write';
}

function tokenFromRequest(request: Request): string {
  const explicit = request.headers.get('x-etla-token')?.trim();
  if (explicit) return explicit;
  const authorization = request.headers.get('authorization')?.trim() || '';
  if (/^Bearer\s+zm[12]\./i.test(authorization)) return authorization.replace(/^Bearer\s+/i, '');
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

export function issueEtlaTokenFromKeyring(
  keyring: MemorySigningKeyring,
  options: {
    ttlMs?: number;
    subject?: string;
    scopes?: AuthScope[];
  } = {},
): { token: string; kid: string } {
  const now = Date.now();
  const ttl = Math.max(60_000, Math.min(options.ttlMs || 15 * 60_000, 60 * 60_000));
  const claims: TokenClaims = {
    ver: 2,
    sub: options.subject || 'zenos-client',
    scopes: options.scopes || ['memory:read', 'memory:write'],
    iat: now,
    exp: now + ttl,
    jti: randomUUID(),
  };
  const encoded = base64url(JSON.stringify(claims));
  const secret = keyring.keys.get(keyring.activeKid);
  if (!secret) throw new Error(`Active Memory signing key ${keyring.activeKid} is unavailable`);
  const prefix = `${ROTATING_TOKEN_PREFIX}.${keyring.activeKid}.${encoded}`;
  const signature = createHmac('sha256', secret).update(prefix, 'utf8').digest('hex');
  return { token: `${prefix}.${signature}`, kid: keyring.activeKid };
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

export function verifyEtlaTokenWithKeyring(
  token: string,
  keyring: MemorySigningKeyring,
  required: AuthScope = 'memory:read',
): TokenClaims | null {
  const parts = token.split('.');
  if (parts.length === 3 && parts[0] === TOKEN_PREFIX) {
    for (const secret of keyring.keys.values()) {
      const claims = verifyEtlaToken(token, secret, required);
      if (claims) return claims;
    }
    return null;
  }
  if (parts.length !== 4 || parts[0] !== ROTATING_TOKEN_PREFIX) return null;
  const kid = parts[1];
  const secret = keyring.keys.get(kid);
  if (!secret) return null;
  const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}.${parts[2]}`, 'utf8').digest('hex');
  if (!safeEqualHex(parts[3], expected)) return null;
  const claims = parseBase64urlJson<TokenClaims>(parts[2]);
  if (!claims || claims.ver !== 2 || !Array.isArray(claims.scopes)) return null;
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
  const keyring = memorySigningKeyring();
  const required = requiredScope(request);

  if (keyring) {
    const token = tokenFromRequest(request);
    if (token && verifyEtlaTokenWithKeyring(token, keyring, required)) return true;

    const safeDirectSignature = !production
      && (request.method === 'GET' || request.method === 'HEAD');
    if (safeDirectSignature) {
      const kid = request.headers.get('x-etla-kid')?.trim();
      if (kid && verifySignatureV3(request, keyring)) return true;
      for (const secret of keyring.keys.values()) {
        if (verifyEtlaSignature(request, secret)) return true;
      }
    }
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
  const keyring = memorySigningKeyring();
  if (!keyring) return false;
  const kid = request.headers.get('x-etla-kid')?.trim();
  let failureReason: SignatureFailureReason | undefined;
  let verified = false;
  if (kid) {
    verified = verifySignatureV3(request, keyring, false, (reason) => { failureReason = reason; });
  } else {
    for (const secret of keyring.keys.values()) {
      if (verifyLegacySignature(request, secret)
        || verifySignatureV2(request, secret, false, (reason) => { failureReason = reason; })) {
        verified = true;
        break;
      }
    }
  }
  if (!verified) {
    console.warn('[ZenosMemory] Token exchange rejected', {
      reason: failureReason || 'unknown',
      kid: kid || 'legacy',
    });
    return false;
  }

  const nonce = request.headers.get('x-etla-nonce') || '';
  const cloudMode = process.env.ZENOS_MEMORY_STORAGE_MODE === 'drive-events';
  const processNonceRegistry = process.env.ZENOS_MEMORY_AUTH_NONCE_STORE === 'process';
  if (cloudMode && !processNonceRegistry) {
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
