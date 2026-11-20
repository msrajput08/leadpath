import {test,expect} from '@playwright/test';
test('home and checker are usable on mobile',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.goto('/');
 await expect(page.getByRole('heading',{name:/Your forms work/i})).toBeVisible();
 await page.goto('/checker');
 await expect(page.getByRole('heading',{name:/Free workflow checker/i})).toBeVisible();
 await page.getByRole('button',{name:/Analyze payload/i}).click();
 await expect(page.getByText(/Valid JSON object/i)).toBeVisible();
 await expect(page.getByText(/No request was sent/i)).toBeVisible();
});
test('broken JSON reports actual syntax failure',async({page})=>{
 await page.goto('/checker');
 await page.getByLabel('Example JSON payload').fill('{bad');
 await page.getByRole('button',{name:/Analyze payload/i}).click();
 await expect(page.getByText(/Invalid JSON:/i)).toBeVisible();
});
test('dashboard shows sign-in without a session',async({page})=>{
 await page.goto('/dashboard');
 await expect(page.getByText(/No sign-in providers are configured/i)).toBeVisible();
});
test('premium signup can send verification and login keeps OAuth providers',async({page})=>{
 await page.route('**/api/public/status',route=>route.fulfill({
  status:200,contentType:'application/json',body:JSON.stringify({
   online:true,google_auth_configured:true,github_auth_configured:true,
   facebook_auth_configured:false,x_auth_configured:false,email_auth_configured:false,password_auth_configured:true
  })
 }));
 await page.route('**/auth/password/signup',route=>route.fulfill({
  status:200,contentType:'application/json',body:JSON.stringify({ok:true})
 }));
 await page.goto('/signup');
 await expect(page.getByRole('heading',{name:/A better way to stay ahead/i})).toBeVisible();
 await page.getByLabel('Full name').fill('Test User');
 await page.getByLabel('Email address').fill('test@example.com');
 await page.getByLabel('Password',{exact:true}).fill('safe-password-example-123');
 await page.getByLabel('Confirm password').fill('safe-password-example-123');
 await page.getByRole('button',{name:/Create free account/i}).click();
 await expect(page.getByRole('heading',{name:/Check your inbox/i})).toBeVisible();
 await expect(page.getByText(/Check your Spam, Junk or Promotions folder too/i)).toBeVisible();
 await page.goto('/login');
 await expect(page.getByRole('heading',{name:/Welcome back/i})).toBeVisible();
 await expect(page.getByRole('link',{name:/Google/i})).toBeVisible();
 await expect(page.getByRole('link',{name:/GitHub/i})).toBeVisible();
 await expect(page.getByRole('link',{name:/Forgot password/i})).toBeVisible();
});

test('confirmation email link verifies automatically then shows login, without requiring a second verification button',async({page})=>{
 const verificationToken='a'.repeat(64);
 let verificationCalls=0;
 await page.route('**/api/public/status',route=>route.fulfill({
  status:200,contentType:'application/json',
  body:JSON.stringify({google_auth_configured:true,github_auth_configured:true,password_auth_configured:true})
 }));
 await page.route('**/auth/password/verify',route=>{
  verificationCalls++;
  expect(route.request().postDataJSON()).toEqual({token:verificationToken});
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true})});
 });
 await page.goto('/verify-email?token_hash='+verificationToken);
 await expect(page.getByRole('heading',{name:/Email verified/i})).toBeVisible();
 await expect(page.getByRole('link',{name:/Continue to login/i})).toBeVisible();
 await expect(page.getByRole('button',{name:/Verify email/i})).toHaveCount(0);
 await expect(page).toHaveURL(/\/verify-email$/);
 expect(verificationCalls).toBe(1);
 await page.getByRole('link',{name:/Continue to login/i}).click();
 await expect(page).toHaveURL(/\/login$/);
 await expect(page.getByRole('heading',{name:/Welcome back/i})).toBeVisible();
});
test('invalid or missing confirmation token never offers a redundant verification button',async({page})=>{
 await page.goto('/verify-email');
 await expect(page.getByText(/verification link is missing its secure token/i)).toBeVisible();
 await expect(page.getByRole('link',{name:/Request a fresh link/i})).toBeVisible();
 await expect(page.getByRole('button',{name:/Verify email/i})).toHaveCount(0);
});
test('password reset form checks matching passwords without sending malformed requests',async({page})=>{
 await page.route('**/api/public/status',route=>route.fulfill({
  status:200,contentType:'application/json',
  body:JSON.stringify({google_auth_configured:false,github_auth_configured:false,password_auth_configured:true})
 }));
 await page.goto('/reset-password?token_hash='+('a'.repeat(64)));
 await page.getByLabel('New password').fill('new-secure-password-123');
 await page.getByLabel('Confirm password').fill('different-secure-password-123');
 await page.getByRole('button',{name:/Update password/i}).click();
 await expect(page.getByText('Passwords do not match.')).toBeVisible();
});

test('public Contact, Privacy and Terms pages have useful live content instead of placeholders',async({page})=>{
 await page.goto('/contact');
 await expect(page.getByRole('heading',{name:/We're here to help/i})).toBeVisible();
 await expect(page.getByRole('link',{name:/minty.12.shar@gmail.com/i})).toHaveAttribute('href',/^mailto:minty\.12\.shar@gmail\.com/);
 await expect(page.getByText(/Support contact details haven't been configured/i)).toHaveCount(0);
 await expect(page.getByText(/Never send passwords, webhook secrets/i)).toBeVisible();
 await page.goto('/privacy');
 await expect(page.getByRole('heading',{name:/Privacy policy/i})).toBeVisible();
 await expect(page.getByRole('heading',{name:/Retention and account controls/i})).toBeVisible();
 await expect(page.getByText(/It does not itself remove a separate Supabase Auth identity/i)).toBeVisible();
 await expect(page.getByText(/DRAFT FOR LAUNCH REVIEW/i)).toHaveCount(0);
 await page.goto('/terms');
 await expect(page.getByRole('heading',{name:/Terms of service/i})).toBeVisible();
 await expect(page.getByRole('heading',{name:/Availability and limits/i})).toBeVisible();
 await expect(page.getByText(/provisional template/i)).toHaveCount(0);
});
test('pricing only shows the actually available free product, and no invented upgrade tiers',async({page})=>{
 await page.goto('/pricing');
 await expect(page.getByRole('heading',{name:/LeadPath is free to use/i})).toBeVisible();
 await expect(page.getByText(/CURRENT PLAN · FREE/i)).toBeVisible();
 await expect(page.getByRole('link',{name:/Create free account/i})).toHaveAttribute('href','/signup');
 await expect(page.getByText(/No paid LeadPath upgrade or checkout is offered/i)).toBeVisible();
 await expect(page.getByText(/\$19|\$49|COMING SOON|PLANNED/i)).toHaveCount(0);
});
test('public pages have canonical URLs while auth and private routes explicitly opt out of indexing',async({page})=>{
 await page.goto('/contact');
 await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content','index, follow');
 await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href','https://leadpath.monty-08-raj.workers.dev/contact');
 await expect(page.locator('meta[name="description"]')).toHaveAttribute('content',/Contact LeadPath support/i);
 await page.goto('/signup');
 await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content','noindex, nofollow');
 await page.goto('/reset-password');
 await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content','noindex, nofollow');
 await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
});
test('documentation links resolve to meaningful articles rather than empty placeholder pages',async({page})=>{
 await page.goto('/docs');
 await expect(page.getByRole('heading',{name:/Guides that solve real problems/i})).toBeVisible();
 const links=await page.locator('a.guide-row').evaluateAll(links=>links.map(a=>(a as HTMLAnchorElement).getAttribute('href')));
 expect(links.length).toBe(6);
 for(const link of links){
  await page.goto(link!);
  await expect(page.getByRole('heading',{name:/Steps to diagnose/i})).toBeVisible();
  await expect(page.locator('.guide-detail ol li').first()).toBeVisible();
 }
});

test('public routes expose complete HTML and metadata before browser-side JavaScript runs',async({request})=>{
 const routes=['/','/how-it-works','/features','/pricing','/checker','/docs','/faq','/contact','/privacy','/terms',
 '/docs/webflow-make','/docs/make-sheets','/docs/crm-missing','/docs/webhook-200','/docs/silent-failures','/docs/free-monitoring'];
 const titles=new Set<string>();
 for(const route of routes){
  const response=await request.get(route);
  expect(response.status(),route).toBe(200);
  const html=await response.text();
  expect(html,route).toContain('data-prerendered="true"');
  expect(html,route).toMatch(/<h1\b[^>]*>/);
  const title=html.match(/<title>(.*?)<\/title>/)?.[1];
  expect(title,route).toBeTruthy();
  titles.add(title!);
  expect(html,route).toContain('<meta name="robots" content="index, follow"/>');
  expect(html,route).toContain('<link rel="canonical" href="https://leadpath.monty-08-raj.workers.dev'+route+'"/>');
  expect(html,route).toContain('<script type="application/ld+json">');
  expect(html,route).not.toContain('DRAFT FOR LAUNCH REVIEW');
 }
 expect(titles.size).toBe(routes.length);
 const sitemap=await request.get('/sitemap.xml');
 expect(sitemap.status()).toBe(200);
 const xml=await sitemap.text();
 for(const route of routes)expect(xml).toContain('<loc>https://leadpath.monty-08-raj.workers.dev'+route+'</loc>');
 expect((xml.match(/<url>/g)||[]).length).toBe(routes.length);
});
test('private routes remain noindex, known pages hydrate and missing pages return true 404',async({page,request})=>{
 for(const route of ['/login','/signup','/reset-password','/verify-email','/dashboard','/account']){
  const response=await request.get(route);
  expect(response.status(),route).toBe(200);
  const html=await response.text();
  expect(html,route).toContain('<meta name="robots" content="noindex, nofollow"/>');
  expect(html,route).not.toContain('data-prerendered="true"');
  expect(html,route).not.toContain('<link rel="canonical"');
 }
 await page.goto('/');
 await expect(page.getByRole('button',{name:'Switch to light mode'})).toBeVisible();
 await page.goto('/docs');
 await expect(page.getByRole('heading',{name:/Guides that solve real problems/i})).toBeVisible();
 const missing=await request.get('/this-page-does-not-exist');
 expect(missing.status()).toBe(404);
 expect(await missing.text()).toContain('Page not found');
 const robots=await (await request.get('/robots.txt')).text();
 expect(robots).toContain('Disallow: /api/');
 expect(robots).not.toContain('Disallow: /signup');
});
test('JSON-LD is parseable and matches visible software and documentation offering',async({request})=>{
 for(const route of ['/','/docs/make-sheets']){
  const html=await (await request.get(route)).text();
  const raw=html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
  expect(raw).toBeTruthy();
  const schema=JSON.parse(raw!);
  expect(schema['@context']).toBe('https://schema.org');
  expect(schema['@graph'].some((item:{'@type':string})=>item['@type']==='WebPage')).toBeTruthy();
  if(route==='/')expect(schema['@graph'].find((item:{'@type':string})=>item['@type']==='WebApplication').offers.price).toBe('0');
  else expect(schema['@graph'].some((item:{'@type':string})=>item['@type']==='BreadcrumbList')).toBeTruthy();
 }
});
