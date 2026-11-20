# LeadPath SEO and discoverability release — 20 November 2026

## Implemented, tested source changes

- All 16 public routes have unique, intent-matched titles and descriptions, a matching canonical, Open Graph/Twitter text and real, build-time HTML. No JavaScript is required for a crawler to read the main content, headings, links or page metadata.
- Routes include home, how-it-works, features, pricing, checker, docs, FAQ, contact, privacy, terms, and six specific troubleshooting guides. The guides provide concrete troubleshooting steps, what success looks like, limits and related internal links.
- Homepage links directly to relevant how-to guides; guide pages cross-link to related troubleshooting articles.
- Homepage structured data describes the truthful free WebApplication. Site and public page structured data use WebSite/WebPage types; docs guide detail pages additionally provide BreadcrumbList. No made-up reviews, ratings, customer counts or unavailable paid packages.
- A single source-of-truth route table in `src/seo.ts` drives all public metadata and the generated sitemap. `npm run build` creates individual static `dist/path.html` files and hydrates the React experience on page load.
- Cloudflare assets `html_handling: drop-trailing-slash` serves the no-suffix canonical URLs without duplicate trailing-slash variants; missing pages return HTTP 404 with a dedicated page instead of a fake 200 homepage.
- Auth and account routes are noindex, non-prerendered shells; they do not leak session data to static HTML. Backend `/api/*` and `/auth/*` routes still run via the Worker.
- Robots blocks backend paths only; sitemap lists public canonical URLs, not private user routes.
- GitHub Playwright tests verify HTTP-returned HTML (not merely rendered DOM), canonical metadata, sitemap coverage, valid JSON-LD, private noindex, genuine 404s, hydration, and legacy authentication/monitoring behavior.

## Owner action to appear in Google Search

1. Deploy the passing merged version, and visit /, /docs/make-sheets, /pricing, /checker and /contact on desktop and mobile.
2. In Google Search Console, add the exact URL-prefix property `https://leadpath.monty-08-raj.workers.dev/`. Complete site ownership verification; this is **not done by the code release**.
3. Submit `https://leadpath.monty-08-raj.workers.dev/sitemap.xml` and use URL Inspection → Test Live URL for representative guides.
4. Verify rendered HTML, canonical selection, coverage, crawl errors and Core Web Vitals after Google processes the property.
5. Search indexing, rankings, rich results, click-through and traffic are Google's decisions and are not promised. There is no guaranteed SEO timeline.

## Production checks before broad acquisition

- Test real Cloudflare response codes and canonical redirects, not just CI's local Wrangler.
- Confirm public robots and sitemap content from Cloudflare, and that password reset routes do not disclose token hashes in pages or referral logs.
- Re-test app sign-in, email confirmation and the Make → Sheets authenticated callback after the release.
- Monitor limits of Workers Free, D1, Supabase Auth, Brevo and Make before large-scale customer acquisition.
- If moving from workers.dev to a custom domain, update `SITE_ORIGIN` in `src/seo.ts`, Cloudflare `BASE_URL`, OAuth callback settings and Supabase email links in a coordinated change. Redirect the previous origin to the canonical one, regenerate sitemap, then update Search Console.
