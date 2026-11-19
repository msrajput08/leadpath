import type { Env, Session } from './types.js';
import { parseCookies, sha256 } from './security.mjs';
export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
 return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
}
export const now = () => Date.now();
export async function getSession(request: Request, env: Env): Promise<Session | null> {
 const token = parseCookies(request.headers.get('cookie'))['__Host-lp_session'] || parseCookies(request.headers.get('cookie'))['lp_session'];
 if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
 const digest = await sha256(token);
 return env.DB.prepare(`SELECT s.user_id,s.csrf_token,s.expires_at,u.email,u.name,u.avatar_url FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`)
  .bind(digest, now()).first<Session>();
}
export function originOf(req: Request): string { return new URL(req.url).origin; }
export function mustBeSameOrigin(request: Request, env: Env): boolean {
 const requestOrigin = request.headers.get('Origin');
 try { return requestOrigin === new URL(env.BASE_URL).origin; } catch { return false; }
}
export function csrfOk(request: Request, session: Session): boolean { return request.headers.get('X-CSRF-Token') === session.csrf_token; }
export function fail(status: number, message: string): Response { return json({ error: message }, status); }
export class InputError extends Error {
 constructor(public status: number, message: string) { super(message); this.name = 'InputError'; }
}
// Enforce limits while streaming; do not buffer an unbounded request before checking.
export async function readBoundedJson(req: Request, maxBytes = 8192): Promise<Record<string, unknown>> {
 if (!(req.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
  throw new InputError(415, 'Expected application/json');
 }
 const header = req.headers.get('content-length');
 if (header !== null && (!/^\d+$/.test(header) || Number(header) > maxBytes)) {
  throw new InputError(413, 'Request body too large');
 }
 if (!req.body) throw new InputError(400, 'A JSON object is required');
 const reader = req.body.getReader();
 const chunks: Uint8Array[] = [];
 let length = 0;
 while (true) {
  const {done,value} = await reader.read();
  if (done) break;
  length += value.byteLength;
  if (length > maxBytes) {
   await reader.cancel().catch(() => undefined);
   throw new InputError(413, 'Request body too large');
  }
  chunks.push(value);
 }
 const bytes = new Uint8Array(length);
 let offset = 0;
 for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
 let payload: unknown;
 try { payload = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes)); }
 catch { throw new InputError(400, 'Malformed JSON'); }
 if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
  throw new InputError(400, 'Expected a JSON object');
 }
 return payload as Record<string, unknown>;
}
export const readSmallJson = (req:Request) => readBoundedJson(req,8192);
export function publicMonitor(row: Record<string, unknown>) {
 const { id, name, state, health, interval_seconds, next_due, last_checked, failure_streak, created_at } = row;
 return { id, name, state, health, interval_seconds, next_due, last_checked, failure_streak, created_at, endpoint: 'Make custom webhook (URL redacted)' };
}
export async function audit(env: Env, userId: string, action: string, targetId?: string) {
 await env.DB.prepare('INSERT INTO audit_events (id,user_id,action,target_id,occurred_at) VALUES(?,?,?,?,?)')
  .bind(crypto.randomUUID(), userId, action, targetId || null, now()).run();
}
