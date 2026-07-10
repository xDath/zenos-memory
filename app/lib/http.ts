import { AppError } from './errors';
import { rateLimit } from './rate-limit';

export function clientAddress(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || request.headers.get('x-real-ip')?.trim() || 'unknown';
}

export function enforceRateLimit(
  request: Request,
  options: { limit?: number; windowMs?: number; bucket?: string } = {},
): void {
  const identity = `${options.bucket || 'api'}:${clientAddress(request)}`;
  if (!rateLimit(identity, options.limit || 120, options.windowMs || 60_000)) {
    throw new AppError('Rate limit exceeded', {
      code: 'RATE_LIMITED',
      status: 429,
      expose: true,
    });
  }
}

export function jsonResponse(
  body: Record<string, unknown>,
  options: { status?: number; requestId?: string; headers?: HeadersInit } = {},
): Response {
  const headers = new Headers(options.headers);
  headers.set('cache-control', 'no-store');
  if (options.requestId) headers.set('x-request-id', options.requestId);
  return Response.json(body, { status: options.status || 200, headers });
}

export function parsePositiveInteger(value: string | null, fallback: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}
