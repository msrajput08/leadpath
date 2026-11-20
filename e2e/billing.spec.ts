import {test,expect} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
let uid:string,token:string,csrf:string;
function sql(query:string){execFileSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','d1','execute','leadpath-db','--local','--command',query],{stdio:'pipe'});}
test.beforeEach(async({context})=>{
 uid=randomUUID();token=randomBytes(32).toString('hex');csrf=randomBytes(16).toString('hex');
 const hash=createHash('sha256').update(token).digest('hex'),t=Date.now();
 sql(`INSERT INTO users(id,email,name,created_at,updated_at) VALUES('${uid}','billing-test@example.invalid','Billing Tester',${t},${t}); INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES('${hash}','${uid}','${csrf}',${t+3600000},${t});`);
 await context.addCookies([{name:'lp_session',value:token,domain:'localhost',path:'/',httpOnly:true,sameSite:'Lax'}]);
});
test.afterEach(()=>sql(`DELETE FROM users WHERE id='${uid}'`));
test('real local D1 billing screen exposes Free usage and disabled upgrade controls',async({page})=>{
 await page.goto('/billing');await expect(page.getByRole('heading',{name:'Room to grow.'})).toBeVisible();
 await expect(page.getByText('Paid subscriptions are not available yet.')).toBeVisible();
 await expect(page.getByRole('button',{name:'Manage subscription'})).toBeDisabled();
 await expect(page.getByRole('button',{name:'Cancel subscription'})).toBeDisabled();
 await expect(page.getByRole('heading',{name:'Starter',exact:true})).toBeVisible();
 await expect(page.getByRole('heading',{name:'Pro',exact:true})).toBeVisible();
 await expect(page.getByText('$9',{exact:false})).toHaveCount(0);
 await expect(page.getByRole('progressbar',{name:'Monitor usage'})).toHaveAttribute('value','0');
 const response=await page.request.get('/api/billing');expect(response.status()).toBe(200);const body=await response.json();expect(body.current_plan).toBe('free');expect(body.checkout_available).toBe(false);
 expect(body.limits.monitors).toBe(1);expect(body.limits.interval_seconds).toBe(21600);
});
test('billing layout fits mobile and retains account settings navigation',async({page},testInfo)=>{
 await page.setViewportSize({width:390,height:844});await page.goto('/billing');
 await expect(page.getByRole('button',{name:'Current plan'})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await page.screenshot({path:testInfo.outputPath('billing-mobile.png'),fullPage:true});
 await page.getByRole('link',{name:'Account settings'}).click();
 await expect(page.getByRole('heading',{name:'Your workspace'})).toBeVisible();
 await expect(page.getByRole('heading',{name:/Telegram notifications/})).toBeVisible();
 await expect(page.getByRole('link',{name:'Plan & billing'})).toBeVisible();
});
test('billing is private and dashboard retains free monitor creation',async({page})=>{
 await page.goto('/billing');expect(await page.locator('meta[name="robots"]').getAttribute('content')).toContain('noindex');
 await page.goto('/dashboard');await expect(page.getByRole('button',{name:'Create monitor'})).toBeVisible();
 await expect(page.getByRole('heading',{name:'Free workspace'})).toBeVisible();
});
