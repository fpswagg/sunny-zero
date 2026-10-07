/**
 * Masks credentials in text an agent is about to read (logs, API responses). Best effort: it
 * catches the common shapes, so tools should still avoid sources that are mostly secrets.
 */
const PATTERNS: [RegExp, string][] = [
  // Connection strings with a password: postgres://user:pass@host
  [/\b([a-z][a-z0-9+.-]*):\/\/([^:\s/@]+):([^@\s]+)@/gi, '$1://$2:***@'],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 ***'],
  // KEY=value / "key": "value" where the name looks secret
  [/\b([A-Za-z0-9_]*(?:token|secret|password|passwd|pwd|api[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret)[A-Za-z0-9_]*)(["']?\s*[=:]\s*["']?)[^\s"',;&]+/gi, '$1$2***'],
  // JWTs
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '***jwt***'],
  // Telegram bot tokens, common API key prefixes
  [/\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g, '***'],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g, '***'],
  [/\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/g, '***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '***'],
  [/\bsa_[a-z]+_[A-Za-z0-9]{16,}\b/g, '***'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, '***'],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

const SECRET_KEY = /pass|secret|token|credential|private|apikey|api_key|enc$|cookie|authorization/i;

/** Deep copy with secret-looking fields masked and strings redacted. */
export function redactObject<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactObject(v)) as T;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) && v != null && v !== '' ? '***' : redactObject(v);
    return out as T;
  }
  return value;
}
