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
 await expect(page.getByText(/No sign-in providers are configured|Continue with Google|Continue with GitHub/i)).toBeVisible();
});

test('all configured sign-in methods render and email OTP offers a code form',async({page})=>{
 await page.route('**/api/public/status',route=>route.fulfill({
  status:200,contentType:'application/json',body:JSON.stringify({
   online:true,google_auth_configured:true,github_auth_configured:true,
   facebook_auth_configured:true,x_auth_configured:true,email_auth_configured:true
  })
 }));
 await page.route('**/auth/email/request',route=>route.fulfill({
  status:200,contentType:'application/json',body:JSON.stringify({ok:true})
 }));
 await page.goto('/login');
 await expect(page.getByRole('link',{name:/Continue with Google/i})).toBeVisible();
 await expect(page.getByRole('link',{name:/Continue with Facebook/i})).toBeVisible();
 await expect(page.getByRole('link',{name:/Continue with X/i})).toBeVisible();
 await expect(page.getByRole('link',{name:/Continue with GitHub/i})).toBeVisible();
 await page.getByLabel('Email address').fill('person@example.test');
 await page.getByRole('button',{name:/Send sign-in code/i}).click();
 await expect(page.getByLabel('6-digit code')).toBeVisible();
});
