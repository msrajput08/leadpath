import type { Subscription } from '../entitlements.js';
export interface BillingEvent {
 id: string; type: string; occurredAt: number; subscriptionId: string | null;
}
export interface VerifiedSubscription {
 customerId: string; subscriptionId: string; priceId: string;
 status: 'pending' | 'trialing' | 'active' | 'past_due' | 'paused' | 'canceled';
 periodStart: number | null; periodEnd: number | null; paidThrough: number | null;
 cancelAtPeriodEnd: boolean; canceledAt: number | null; updatedAt: number;
}
// No provider-specific SDK or card handling leaks into entitlement/monitoring code.
// Checkout/portal creation remain intentionally unavailable in this release.
export interface BillingProvider {
 name: string;
 signatureHeader: string;
 environment: 'sandbox' | 'live';
 verify(raw: string, signature: string, time: number): Promise<BillingEvent>;
 readSubscription(binding: Subscription): Promise<VerifiedSubscription>;
}
export class BillingError extends Error {
 constructor(public code: string, public status=503) { super(code); }
}
