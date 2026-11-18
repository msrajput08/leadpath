import {describe,it,expect} from 'vitest';
import {validateMakeWebhook,validateJsonSample} from '../worker/security.mjs';
describe('validation functions',()=>{
 it('blocks request forgery targets',()=>{
  expect(validateMakeWebhook('https://localhost/run').ok).toBe(false);
  expect(validateMakeWebhook('https://169.254.169.254/latest/meta-data').ok).toBe(false);
  expect(validateMakeWebhook('https://hook.eu1.make.com.evil.example/test123456').ok).toBe(false);
 });
 it('requires a meaningful JSON object',()=>{
  expect(validateJsonSample('[]').ok).toBe(false);
  expect(validateJsonSample('{"run_id":"test"}').hasRunId).toBe(true);
 });
});
