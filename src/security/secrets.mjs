import crypto from 'node:crypto';
import path from 'node:path';

export const SECRET_POLICY_VERSION = '2026-08-16.1';

const SENSITIVE_NAMES = [
  /^\.env(?:\..+)?$/i,
  /^(?:id_rsa|id_ed25519)(?:\..+)?$/i,
  /^(?:credentials|secrets?|tokens?)(?:[._-].*)?$/i,
  /^(?:config|credentials)$/i,
  /(?:^|\.)git-credentials$/i,
  /(?:service[-_]?account|client[-_]?secret).*\.json$/i,
  /\.(?:pem|key|p12|pfx)$/i
];

export function classifySensitivePath(relativePath) {
  const normalized = String(relativePath || '').replaceAll('\\', '/');
  const lower = normalized.toLowerCase();
  const basename = path.posix.basename(normalized);
  if (lower === '.ssh' || lower.startsWith('.ssh/') || lower.includes('/.ssh/')) return { sensitive: true, rule: 'ssh-material' };
  if (lower.includes('browser profile') || lower.includes('/user data/') || lower.startsWith('user data/')) return { sensitive: true, rule: 'browser-profile' };
  if (lower === '.aws/credentials' || lower === '.aws/config' || lower.includes('/.aws/credentials') || lower.includes('/.aws/config')) return { sensitive: true, rule: 'aws-credentials-file' };
  const rule = SENSITIVE_NAMES.find(pattern => pattern.test(basename));
  return rule ? { sensitive: true, rule: 'sensitive-filename' } : { sensitive: false, rule: '' };
}

function fingerprint(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex').slice(0, 16);
}

const RULES = [
  { name: 'private-key-block', confidence: 'high', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { name: 'authorization-header', confidence: 'high', pattern: /\bAuthorization\s*:\s*(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi },
  { name: 'github-token', confidence: 'high', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { name: 'aws-access-key', confidence: 'high', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: 'openai-key', confidence: 'high', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: 'credentialed-url', confidence: 'high', pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s:@/]+:[^\s@/]+@[^\s]+/gi },
  { name: 'password-assignment', confidence: 'high', pattern: /\b(?:password|passwd|pwd|client_secret|api_key|access_token)\s*[:=]\s*['"]?[^\s'";,]{8,}/gi },
  { name: 'jwt-like-token', confidence: 'lower', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: 'generic-bearer-token', confidence: 'lower', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi }
];

export function scanOutgoingText(input, { source = '' } = {}) {
  let text = String(input || '');
  const detections = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    const matches = [...text.matchAll(rule.pattern)];
    for (const match of matches) {
      detections.push({ rule: rule.name, confidence: rule.confidence, source, location: match.index, fingerprint: fingerprint(match[0]) });
    }
    if (rule.confidence === 'lower' && matches.length) {
      rule.pattern.lastIndex = 0;
      text = text.replace(rule.pattern, `[REDACTED:${rule.name}]`);
    }
  }
  return {
    text,
    blocked: detections.some(item => item.confidence === 'high'),
    redacted: detections.some(item => item.confidence === 'lower'),
    detections
  };
}
