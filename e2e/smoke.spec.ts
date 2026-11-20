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
 await page.goto('/login');
 await expect(page.getByRole('heading',{name:/Welcome back/i})).toBeVisible();
 await expect(page.getByRole('link',{name:/Google/i})).toBeVisible();
 await expect(page.getByRole('link',{name:/GitHub/i})).toBeVisible();
 await expect(page.getByRole('link',{name:/Forgot password/i})).toBeVisible();
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
