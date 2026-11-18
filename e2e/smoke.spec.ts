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
 await expect(page.getByText(/sign-in is not configured|Continue with Google|Continue with GitHub/i)).toBeVisible();
});
