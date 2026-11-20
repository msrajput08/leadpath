# Cost and capacity model — 20 November 2026

## Current fixed cost

**Additional monthly fixed cost from this PR: $0.** No services or paid plans have been purchased. Assuming the existing Workers/D1, Supabase Auth, Brevo and workers.dev hosting remain on their free tiers, the platform's modeled fixed subscription cost is **$0/month**. Actual account invoices/configuration were not inspected. Customer Make/Google accounts and any previously purchased domain/service are independent.

Keeping fixed cost at zero does **not** mean unlimited reliable monitoring. On the present configuration, quotas stop/defer work, rather than silently upgrading accounts or charging overages. Infrastructure/transaction prices below are estimates for a future explicitly approved paid architecture, not services activated by this change.

## Capacity first

| Account at full proposed allowance | Checks/day | Checks/30 days | Illustrative Make credits/month at 3 modules/check |
| --- | ---: | ---: | ---: |
| Free: 1 × every 6h | 4 | 120 | 360 |
| Starter: 5 × hourly | 120 | 3,600 | 10,800 |
| Pro: 25 × every 15m | 2,400 | 72,000 | 216,000 |

Actual Make credits depend on module/bundle behavior. They belong to the customer's Make account. Make Free advertises 1,000 credits/month; additional real lead traffic shares that budget. Paid LeadPath cannot promise these volumes will fit a customer's free Make plan.

The unchanged 15-minute cron and three-check batch cap yield at most **288 scheduled checks/day** for the whole app. The six-hour floor stays on. Even **100 fully active Free users need 400/day**, above the cap. Theoretical capacity is 72 Free users before headroom, pending timeouts or downtime; use a substantially lower admission limit until measured. Full Pro is impossible under these defaults, even with one Pro customer. Faster intervals do not intrinsically force a paid Cloudflare plan at tiny workloads; the proposed *full monitor allowances* and the current bounded single-worker design are the problem. No plan is automatically enabled merely because an interval is configured.

## Planning scenarios at 100 / 1,000 / 10,000 users

Mixed scenario assumes 80% Free, 15% Starter, 5% Pro; every monitor slot used, all verified/active, every proposed interval delivered, 30-day month and 90-day retained history. **The current PR cannot deliver this scenario**: it needs reviewed dispatcher/fan-out and maintenance changes, load tests, capacity admission and, at larger sizes, D1 sharding. It is a core compute/database estimate, not a full operating quote.

Conservative assumptions for reproducibility (`node scripts/cost-model.mjs`):

- 141.2 checks/user/day in that mix; one callback HTTP request/check and 20 other API requests/user/day.
- 30 D1 billable written rows/check including indexes, updates, usage and amortized cleanup, plus 10/user/day; 100 read rows/check + 3,000/user/day. These are modeled, **not measured production row costs**. Cleanup and notification behavior can change them materially.
- 3,000 bytes retained per check including indexes/associated records; 90 days. Database overhead and financial ledger retention may add more.
- 5 ms CPU per HTTP request. Dispatcher/queue/reconciliation CPU and future queue charges are excluded and must be added after design/measurement.
- Workers Paid $5 minimum, 10m requests + 30m CPU-ms included monthly; excess $0.30/m requests and $0.02/m CPU-ms. D1 includes 50m writes, 25b reads and 5 GB; extra $1/m writes, $0.001/m reads and $0.75/GB-month. No extra database-count charge at these shard counts under the published allowance.
- Supabase stays under 50,000 MAU/other Free quotas; auth mail stays <=300 sends/day on Brevo. No extra alert-email service, paid analytics, purchased domain, support labour, tax, FX or dispute cost included.

| Registered/active users | Scheduled checks/day | D1 writes/month | Retained GB | Future fixed minimum | Estimated Workers + D1 total/month | Paddle processing/month* |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 14,120 | 12.738m | 3.812 | $5 | **$5.00** | $24 |
| 1,000 | 141,200 | 127.380m | 38.124 | $5 | **$107.22** | $240 |
| 10,000 | 1,412,000 | 1,273.800m | 381.240 | $5 | **$1,526.72** | $2,400 |

\* One successful monthly charge per paid customer at provisional $9/$29 and 5%+$0.50, excludes other settlement/refund/tax effects. Corresponding hypothetical monthly revenue is $280 / $2,800 / $28,000, not a forecast of customers or profit. At 1,000 users, the estimate consists of $5 Workers + $77.38 D1 writes + $24.843 storage. At 10,000: $20.744 Workers + $1,223.80 writes + $282.18 storage; read charges remain within inclusion.

All-Free scenario is much lighter: 400 / 4,000 / 40,000 checks per day and approximately 0.108 / 1.08 / 10.8 GB at 90 days. Ignoring the current dispatcher cap, optimized capacity might fit $0 at 100 users if actual CPU/quotas pass; at 1,000 users modeled 120k+ writes/day exceeds Free. Paid-rate core estimates are $5 / $5 / $9.47 for these three all-Free cases (the first could remain Free if capacity is solved). The 10,000 case exceeds one Paid D1 database's 10 GB limit and requires storage redesign/sharding. None of these are current launch capacity promises.

Sensitivities: doubling written-row amplification adds roughly $127/month at 1,000 mixed users and $1,271/month at 10,000; reducing actual monitor use or cadence reduces load sharply. Measure D1 metadata and retained bytes before setting commercial limits.

## Published free constraints

- Workers: 100,000 requests/day; 10 ms CPU per HTTP **and Cron** invocation; 50 external subrequests; five cron triggers/account. Static asset delivery and dynamic Worker invocations have distinct billing treatment.
- D1: 5m rows read/day, 100k rows written/day, 500 MB/database and 5 GB/account. Limit exhaustion fails queries until reset; a database cannot simply grow to the total account allowance. Paid D1 max is 10 GB/database.
- D1 invocation query limit is 50 Free / 1,000 Paid; published current docs count a `batch()` as one invocation query even though its statements still incur row work. Tests conservatively count each batch statement separately.
- Supabase Free: 50,000 MAU, 500 MB database, 5 GB egress, inactivity pause; production auth reliability still needs observation.
- Brevo Free: 300 sends/day (shared with other email use). Launch spikes/password-reset abuse can exhaust it even with a low user total.

Resource ceilings constrain run starts, not every account-wide request/row. Account creation, malicious callbacks, billing webhook traffic, historic-data size and other Workers on the account can also exhaust quotas. No cap should be represented as a guaranteed invoice bound on a paid account.

## Primary sources (retrieved 20 November 2026)

- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/d1/platform/limits/
- https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/
- https://supabase.com/pricing
- https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan
- https://www.make.com/en/pricing
- https://www.paddle.com/pricing
