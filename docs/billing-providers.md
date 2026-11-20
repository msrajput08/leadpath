# Billing-provider decision — researched 20 November 2026

**Recommendation:** evaluate Paddle first for an India-based solo SaaS founder selling internationally. Its merchant-of-record model can handle customer sales-tax collection/remittance and recurring billing without a fixed monthly fee. Eligibility is **conditional on onboarding**, not a claim that LeadPath has an approved account. Keep Razorpay as a future alternative, particularly for Indian customers/UPI. Stripe is not a dependable immediate onboarding path in India.

The implementation uses a replaceable `BillingProvider` contract with a Paddle read/verification adapter and disabled checkout. No account was created, no KYC supplied, no secrets invented, no customer charged, and no service purchased.

| Provider | Fixed cost / transaction pricing | International recurring & currencies | Indian founder onboarding | Refunds / taxes / Workers fit |
| --- | --- | --- | --- | --- |
| **Paddle** | Standard pay-as-you-go: no monthly fee; 5% + US$0.50 per checkout transaction. At proposed prices, roughly $0.95 on $9 and $1.95 on $29 before any additional payout/FX/tax effects. | SaaS subscriptions; 30+ payment currencies including USD; multiple balance/payout currencies. Confirm payout/FX arrangements for the actual Indian bank. | India is absent from its unsupported supplier-country list; eligibility is an inference from the published country policy, subject to product/domain review, identity verification and acceptance. Business verification is not required for individuals/sole traders per its verification guide, but identity/domain review still apply. | Merchant of record handles transaction sales tax; founder's own Indian income/export/accounting duties remain. Provider refund policy and mandatory consumer rights apply. HTTPS REST + raw-body HMAC-SHA256 works with Workers Web Crypto. |
| **Razorpay** | No setup/maintenance fee; standard domestic rate 2% + GST; international page advertises 3% + GST. Subscription page currently advertises promotional 0.5% add-on (crossed-out 0.9%), on top of underlying processing. Confirm contracted recurring/international pricing; do not budget a promotion as permanent. | International subscriptions/card recurring supported; subscription page says nearly 100 currencies. Broader gateway page says 160+; these are not the same product guarantee. International settlements in INR; UPI/eMandate use INR. | KYC, PAN/business documents, bank and international enablement required. Official international documentation distinguishes registered businesses eligible for cards from individuals directed to PayPal/bank transfer. Do **not** assume an unregistered individual qualifies for the international recurring-card product. Get written approval for the founder's actual business type. | Gateway, not automatic merchant of record for worldwide SaaS tax. Merchant owns tax/invoice/export/refund compliance. Dashboard/API full/partial refunds; original charges/FX treatment need contract confirmation. REST + HMAC webhooks can run without a Node SDK. |
| **Stripe India** | Pay-as-you-go payments. Domestic Visa/Mastercard 2%; international USD/other-currency presentment 4.3%, +2% if conversion required; Billing 0.7% of volume additional. Contract, tax and card mix matter. | Recurring Billing; 135+ international currencies, subject to India export and authentication rules. | India remains invite-only. International payments require supported registered business/sole proprietorship, KYC and export information; individuals are not supported for international payments. IEC rules vary by service export/card (including AMEX). | Standard Stripe Payments/Billing does not remove merchant tax obligations. Refund/FX/dispute fees may remain. Workers REST and Web Crypto integration is feasible, but access/onboarding is the blocker. |

## Why Paddle, provisionally

The extra fixed per-transaction component is significant on $9 (about 10.6% effective fee). It may still be worth the reduced global consumer-tax administration for a solo founder. This is an engineering/business recommendation, not legal or tax advice or a promise of merchant approval. Confirm USD pricing, settlement currency, payout thresholds, refund/chargeback charges, allowed business model and final fees directly in the merchant agreement before selection is final.

Avoid assuming a dollar-denominated website price means an Indian gateway account can collect USD recurring card payments. For Razorpay, confirm **Subscriptions + international cards + the exact merchant entity type**, not only generic international payments. No PayPal or Stripe workaround is silently substituted.

Before launch, obtain an adviser’s assessment of Indian GST/export-of-service treatment, any LUT/registration requirements, settlement records/purpose codes, income tax, invoices and cross-border consumer obligations for the chosen contracting structure. Paddle handling customer transaction taxes does not settle all of the founder's own obligations. No business entity, GST status or tax exemption is assumed.

## Primary sources

- Paddle pricing: https://www.paddle.com/pricing
- Supplier countries: https://www.paddle.com/help/legal/sanctions/which-countries-are-supported-by-paddle
- Account verification: https://www.paddle.com/help/start/account-verification/what-is-account-verification
- Currencies: https://developer.paddle.com/concepts/sell/supported-currencies/
- Refund policy: https://www.paddle.com/legal/refund-policy
- Signature verification: https://developer.paddle.com/webhooks/about/signature-verification/
- Subscription provisioning: https://developer.paddle.com/build/subscriptions/provision-access-webhooks/
- Transactions / adjustments: https://developer.paddle.com/api-reference/transactions/list-transactions/ and https://developer.paddle.com/api-reference/adjustments/list-adjustments/
- Go-live checks / webhook response target: https://developer.paddle.com/build/go-live-checklist/
- Razorpay standard pricing: https://razorpay.com/pricing/
- International pricing: https://razorpay.com/international/
- Subscription pricing / supported currencies: https://razorpay.com/subscriptions/
- Merchant-type eligibility / onboarding: https://razorpay.com/docs/payments/international-payments/
- Subscription international currencies/INR settlement: https://razorpay.com/docs/payments/subscriptions/faqs/
- Refunds: https://razorpay.com/docs/payments/refunds/
- Stripe India eligibility: https://support.stripe.com/questions/accepting-international-payments-from-stripe-accounts-in-india
- Invite-only status: https://support.stripe.com/questions/moving-to-invite-only-in-india
- Stripe India rates: https://stripe.com/in/pricing

Recheck these changing commercial terms when onboarding; broad marketing coverage is not proof of account-specific activation.
