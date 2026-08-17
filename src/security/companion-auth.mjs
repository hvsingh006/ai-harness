import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

function base64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function hash(value, installSecret = '') {
  return installSecret
    ? crypto.createHmac('sha256', installSecret).update(String(value)).digest('hex')
    : crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function ensureInstallCredential(runtimeDir) {
  fs.mkdirSync(runtimeDir, { recursive: true });
  const credentialPath = path.join(runtimeDir, 'companion-credential.json');
  if (!fs.existsSync(credentialPath)) {
    const payload = { version: 1, secret: base64url(crypto.randomBytes(32)), created_at: new Date().toISOString() };
    fs.writeFileSync(credentialPath, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }
  const parsed = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
  if (!parsed.secret || Buffer.from(parsed.secret, 'base64url').length < 32) throw new Error('invalid companion install credential');
  return { path: credentialPath, secret: parsed.secret };
}

export function createPairingChallenge(db, { ttlMs = 2 * 60 * 1000, now = Date.now(), installSecret = '' } = {}) {
  const challenge = base64url(crypto.randomBytes(32));
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ttlMs).toISOString();
  db.prepare('DELETE FROM pairing_challenges WHERE expires_at < ? OR used_at IS NOT NULL').run(createdAt);
  db.prepare('INSERT INTO pairing_challenges (challenge_hash,expires_at,created_at) VALUES (?,?,?)').run(hash(challenge, installSecret), expiresAt, createdAt);
  return { challenge, expires_at: expiresAt };
}

export function completePairing(db, { challenge, extensionId, now = Date.now(), installSecret = '' }) {
  if (!EXTENSION_ID_PATTERN.test(String(extensionId || ''))) throw Object.assign(new Error('invalid extension identity'), { statusCode: 400 });
  const challengeHash = hash(challenge || '', installSecret);
  const record = db.prepare('SELECT * FROM pairing_challenges WHERE challenge_hash=?').get(challengeHash);
  const nowIso = new Date(now).toISOString();
  if (!record || record.used_at || record.expires_at <= nowIso) throw Object.assign(new Error('pairing challenge invalid or expired'), { statusCode: 401 });
  const token = base64url(crypto.randomBytes(32));
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE pairing_challenges SET used_at=? WHERE challenge_hash=? AND used_at IS NULL').run(nowIso, challengeHash);
    db.prepare(`INSERT INTO companion_pairings (extension_id,token_hash,paired_at,last_seen_at,revoked_at)
                VALUES (?,?,?,?,NULL)
                ON CONFLICT(extension_id) DO UPDATE SET token_hash=excluded.token_hash,paired_at=excluded.paired_at,last_seen_at=excluded.last_seen_at,revoked_at=NULL`).run(
      extensionId, hash(token, installSecret), nowIso, nowIso
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { token, extension_id: extensionId, paired_at: nowIso };
}

export function authenticateCompanionRequest(db, req, { installSecret = '' } = {}) {
  const token = String(req.headers['x-aih-companion-token'] || '');
  const extensionId = String(req.headers['x-aih-extension-id'] || '');
  if (!token || !EXTENSION_ID_PATTERN.test(extensionId)) return { ok: false, code: 'COMPANION_UNAUTHENTICATED', message: 'browser companion authentication required' };
  const pairing = db.prepare('SELECT * FROM companion_pairings WHERE extension_id=? AND revoked_at IS NULL').get(extensionId);
  if (!pairing) return { ok: false, code: 'COMPANION_UNAUTHENTICATED', message: 'browser companion is not paired' };
  const supplied = Buffer.from(hash(token, installSecret));
  const expected = Buffer.from(pairing.token_hash);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    return { ok: false, code: 'COMPANION_UNAUTHENTICATED', message: 'browser companion token rejected' };
  }
  const origin = String(req.headers.origin || '');
  if (origin && origin !== `chrome-extension://${extensionId}`) {
    return { ok: false, code: 'COMPANION_ORIGIN_REJECTED', message: 'browser companion origin rejected' };
  }
  const now = new Date().toISOString();
  db.prepare('UPDATE companion_pairings SET last_seen_at=? WHERE extension_id=?').run(now, extensionId);
  return { ok: true, extensionId, origin: origin || `chrome-extension://${extensionId}`, pairing };
}

export function isSameOriginDashboardRequest(req, port) {
  const origin = String(req.headers.origin || '');
  if (!origin) return false;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

export function pairedCompanionStatus(db) {
  const pairing = db.prepare('SELECT extension_id,paired_at,last_seen_at FROM companion_pairings WHERE revoked_at IS NULL ORDER BY last_seen_at DESC LIMIT 1').get();
  return pairing || null;
}
