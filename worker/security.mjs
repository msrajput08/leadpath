/** Dependency-free validation and cryptographic helpers shared with Node tests. */
const encoder = new TextEncoder();
export const MIN_INTERVAL_SECONDS = 21600;
export const CONFIRMATION_WINDOW_MS = 30 * 60 * 1000;
export const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function validateMakeWebhook(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return { ok: false, error: 'Provide a webhook URL under 2048 characters.' };
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return { ok: false, error: 'Only HTTPS webhooks are permitted.' };
    if (!/^hook\.[a-z0-9-]+\.make\.com$/.test(url.hostname)) return { ok: false, error: 'For the MVP, use an official Make custom webhook (hook.REGION.make.com).' };
    if (!/^\/[a-zA-Z0-9_-]{8,}$/.test(url.pathname)) return { ok: false, error: 'Make webhook path is missing or malformed.' };
    if (url.username || url.password || url.port || url.hash || url.search) return { ok: false, error: 'Webhook URL may not contain credentials, a port, query, or fragment.' };
    return { ok: true, url: url.toString() };
  } catch { return { ok: false, error: 'Invalid URL.' }; }
}

export function validateJsonSample(value) {
  if (typeof value !== 'string' || value.length > 10000) return { ok: false, error: 'Sample JSON must be under 10KB.' };
  try {
    const parsed = JSON.parse(value);
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') return { ok: false, error: 'The webhook body must be a JSON object.' };
    return { ok: true, keys: Object.keys(parsed).length, hasRunId: typeof parsed.run_id === 'string', warnings: typeof parsed.run_id === 'string' ? [] : ['Missing run_id: delivery confirmation cannot be correlated.'] };
  } catch (err) { return { ok: false, error: err instanceof Error ? err.message : 'Invalid JSON' }; }
}
export function newRandomString(bytes = 32) {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}
export async function sha256(s) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(s));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
/**
 * Prove that a monitor's callback has seen a server-only challenge sent to
 * its Make webhook. This value must never appear in the run API response.
 * Reuse the existing server-side encryption key, with domain-separated HMAC.
 */
export async function webhookOwnershipProof(runId, keyHex) {
  if (typeof keyHex !== 'string' || !/^[a-fA-F0-9]{64}$/.test(keyHex)) throw new Error('Webhook proof key unavailable.');
  const bytes = Uint8Array.from(keyHex.match(/../g).map(x => parseInt(x, 16)));
  const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`leadpath-ownership-v1:${runId}`)));
  return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
}
export function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
function bytesToB64(arr) { return btoa(String.fromCharCode(...arr)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''); }
function b64ToBytes(s) { const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - s.length % 4) % 4)); return Uint8Array.from(bin, c => c.charCodeAt(0)); }
async function importAes(keyHex) {
  if (typeof keyHex !== 'string' || !/^[a-fA-F0-9]{64}$/.test(keyHex)) throw new Error('WEBHOOK_ENCRYPTION_KEY must be 32 random bytes in hex.');
  const bytes = Uint8Array.from(keyHex.match(/../g).map(x => parseInt(x, 16)));
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
export async function encryptSecret(plaintext, keyHex) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importAes(keyHex);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext)));
  return `v1.${bytesToB64(iv)}.${bytesToB64(encrypted)}`;
}
export async function decryptSecret(ciphertext, keyHex) {
  const [, iv, data] = ciphertext.split('.');
  if (!ciphertext.startsWith('v1.') || !iv || !data) throw new Error('Malformed encrypted webhook');
  const key = await importAes(keyHex);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(iv) }, key, b64ToBytes(data));
  return new TextDecoder().decode(plain);
}
export function syntheticPayload(runId, now, callbackUrl) {
  return { run_id: runId, leadpath_test: true, record_type: 'SYNTHETIC_TEST_DO_NOT_CONTACT',
    sample_name: 'LeadPath Test', sample_email: 'test@example.invalid',
    triggered_at: new Date(now).toISOString(), confirmation_url: callbackUrl };
}
export function parseCookies(header) {
  return Object.fromEntries((header || '').split(';').map(p => p.trim()).filter(Boolean).map(p => {
    const eq = p.indexOf('='); return eq < 0 ? [p, ''] : [p.slice(0, eq), p.slice(eq + 1)];
  }));
}
export function secureCookie(name, value, maxAge, secure = true) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
