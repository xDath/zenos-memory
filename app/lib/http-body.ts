import { PayloadTooLargeError, ValidationError } from './errors';

const DEFAULT_MAX_BODY_BYTES = 768_000;

function positiveInteger(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export async function readJsonBodyBounded(
  request: Request,
  maxBytes = DEFAULT_MAX_BODY_BYTES,
): Promise<unknown> {
  const boundedMax = Math.max(1_024, Math.min(maxBytes, 4 * 1024 * 1024));
  const declaredLength = positiveInteger(request.headers.get('content-length'));
  if (declaredLength !== undefined && declaredLength > boundedMax) {
    throw new PayloadTooLargeError('Request body exceeds the allowed size', {
      max_bytes: boundedMax,
      declared_bytes: declaredLength,
    });
  }

  if (!request.body) throw new ValidationError('Request body is required');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      received += value.byteLength;
      if (received > boundedMax) {
        await reader.cancel('request body too large').catch(() => undefined);
        throw new PayloadTooLargeError('Request body exceeds the allowed size', {
          max_bytes: boundedMax,
          received_bytes: received,
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (!received) throw new ValidationError('Request body is required');
  const body = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new ValidationError('Request body contains invalid JSON', {
      received_bytes: received,
      parser_error: error instanceof SyntaxError ? 'invalid-json' : 'unknown',
    });
  }
}
