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
export async function readSmallJson(req: Request): Promise<Record<string, unknown>> {
 const size = Number(req.headers.get('content-length') || '0');
 if (size > 8192) throw new Error('Body exceeds 8KB');
 if (!(req.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) throw new Error('Expected application/json');
 const text = await req.text();
 if (text.length > 8192) throw new Error('Body exceeds 8KB');
 const value = JSON.parse(text);
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
 return value as Record<string, unknown>;
}
export function publicMonitor(row: Record<string, unknown>) {
 const { id, name, state, health, interval_seconds, next_due, last_checked, failure_streak, created_at } = row;
 return { id, name, state, health, interval_seconds, next_due, last_checked, failure_streak, created_at, endpoint: 'Make custom webhook (URL redacted)' };
}
export async function audit(env: Env, userId: string, action: string, targetId?: string) {
 await env.DB.prepare('INSERT INTO audit_events (id,user_id,action,target_id,occurred_at) VALUES(?,?,?,?,?)')
  .bind(crypto.randomUUID(), userId, action, targetId || null, now()).run();
}
