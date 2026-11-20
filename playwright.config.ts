import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./e2e',use:{baseURL:'http://localhost:8787',
 launchOptions:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{}
},retries:0,reporter:'list'});
