import { createHash } from 'node:crypto';
import { SensitiveDataError } from './errors';

interface SecretPattern {
  name: string;
  pattern: RegExp;
  replacement: string;
}

const SECRET_PATTERNS: SecretPattern[] = [
  { name: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g, replacement: '[REDACTED_PRIVATE_KEY]' },
  { name: 'jwt', pattern: /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/g, replacement: '[REDACTED_JWT]' },
  { name: 'openai', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, replacement: '[REDACTED_OPENAI_KEY]' },
  { name: 'anthropic', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, replacement: '[REDACTED_ANTHROPIC_KEY]' },
  { name: 'github', pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
  { name: 'google', pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g, replacement: '[REDACTED_GOOGLE_KEY]' },
  { name: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: '[REDACTED_AWS_ACCESS_KEY]' },
  { name: 'slack', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: '[REDACTED_SLACK_TOKEN]' },
  { name: 'stripe', pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, replacement: '[REDACTED_STRIPE_KEY]' },
  { name: 'vercel', pattern: /\bvcp_[A-Za-z0-9_-]{16,}\b/g, replacement: '[REDACTED_VERCEL_TOKEN]' },
  { name: 'discord', pattern: /\b(?:mfa\.[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,})\b/g, replacement: '[REDACTED_DISCORD_TOKEN]' },
  { name: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gi, replacement: 'Bearer [REDACTED_TOKEN]' },
  { name: 'basic-auth', pattern: /\bBasic\s+[A-Za-z0-9+/=]{16,}\b/gi, replacement: 'Basic [REDACTED_CREDENTIAL]' },
  {
    name: 'assigned-secret',
    pattern: /\b(?:password|passwd|pwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key)\s*[:=]\s*["']?[^\s,"']{8,}["']?/gi,
    replacement: '[REDACTED_ASSIGNED_SECRET]',
  },
];

export interface SecretScanResult {
  detected: boolean;
  categories: string[];
  redacted: string;
}

export function scanSensitiveText(input: string): SecretScanResult {
  let redacted = input;
  const categories = new Set<string>();

  for (const item of SECRET_PATTERNS) {
    item.pattern.lastIndex = 0;
    if (item.pattern.test(redacted)) categories.add(item.name);
    item.pattern.lastIndex = 0;
    redacted = redacted.replace(item.pattern, item.replacement);
  }

  return {
    detected: categories.size > 0,
    categories: [...categories].sort(),
    redacted,
  };
}

export function redactSensitiveText(input: string): string {
  return scanSensitiveText(input).redacted;
}

export function assertMemorySafe(content: string, type?: string): void {
  if (type === 'secret_reference') {
    if (!isSecretReference(content)) {
      throw new SensitiveDataError('Secret references must use a vault://, secret://, or op:// URI; raw secret values are forbidden');
    }
    return;
  }

  if (type === 'credential') {
    throw new SensitiveDataError('The credential memory type is deprecated; store a vault reference with type=secret_reference');
  }

  if (scanSensitiveText(content).detected) {
    throw new SensitiveDataError();
  }
}

export function isSecretReference(content: string): boolean {
  return /^(?:vault|secret|op):\/\/[a-zA-Z0-9][a-zA-Z0-9._~:/?#\[\]@!$&'()*+,;=%-]{2,1020}$/.test(content.trim());
}

export function contentHash(content: string): string {
  return createHash('sha256').update(content.normalize('NFKC'), 'utf8').digest('hex');
}

export function sanitizeUnknown(value: unknown): unknown {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(sanitizeUnknown);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, sanitizeUnknown(item)]),
    );
  }
  return value;
}
