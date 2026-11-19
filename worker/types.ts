export interface D1PreparedStatement {
 bind(...args: unknown[]): D1PreparedStatement;
 first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
 all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean }>;
 run(): Promise<{ success: boolean; meta: { changes: number } }>;
}
export interface D1Database {
 prepare(sql: string): D1PreparedStatement;
 batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<T[]>;
}
export interface Env {
 DB: D1Database;
 BASE_URL: string;
 GOOGLE_CLIENT_ID?: string;
 GOOGLE_CLIENT_SECRET?: string;
 GITHUB_CLIENT_ID?: string;
 GITHUB_CLIENT_SECRET?: string;
 FACEBOOK_APP_ID?: string;
 FACEBOOK_APP_SECRET?: string;
 X_CLIENT_ID?: string;
 X_CLIENT_SECRET?: string;
 RESEND_API_KEY?: string;
 EMAIL_FROM_ADDRESS?: string;
 EMAIL_OTP_SECRET?: string;
 WEBHOOK_ENCRYPTION_KEY?: string;
 TELEGRAM_BOT_TOKEN?: string;
 RATE_LIMITER?: {limit(input:{key:string}):Promise<{success:boolean}>};
}
export interface Monitor {
 id: string; user_id: string; name: string; webhook_ciphertext: string; secret_hash: string; verified_at: number | null;
 state: 'active' | 'paused'; health: string; interval_seconds: number; next_due: number;
 lock_until: number | null; last_run_id: string | null; failure_streak: number; last_checked: number | null;
 created_at: number; updated_at: number;
}
export interface Run {
 id: string; monitor_id: string; state: 'pending' | 'confirmed' | 'unconfirmed' | 'error';
 source: 'scheduled' | 'manual'; trigger_sent_at: number | null;
 trigger_accepted_at: number | null; response_status: number | null;
 error_code: string | null; created_at: number; expires_at: number;
 confirmed_at: number | null; duration_ms: number | null;
}
export interface Session { user_id: string; csrf_token: string; expires_at: number; email: string; name: string; avatar_url: string | null; }
