import test from 'node:test';
import assert from 'node:assert/strict';
import {validateMakeWebhook,validateJsonSample,encryptSecret,decryptSecret,sha256,constantTimeEqual,syntheticPayload,newRandomString} from '../worker/security.mjs';
test('accept only sanctioned Make HTTPS webhook URLs',()=>{
 assert.equal(validateMakeWebhook('https://hook.eu1.make.com/AbcdEFgh123').ok,true);
 for(const value of ['http://hook.eu1.make.com/AbcdEFgh123','https://127.0.0.1/AbcdEFgh123','https://hook.eu1.make.com.evil.tld/AbcdEFgh123','https://hook.eu1.make.com@evil.com/AbcdEFgh123','https://hook.eu1.make.com:444/AbcdEFgh123','https://hook.eu1.make.com/AbcdEFgh123?next=x','https://hook.eu1.make.com/', 'https://[::1]/fakefakefake']) assert.equal(validateMakeWebhook(value).ok,false,value);
});
test('JSON checker rejects malformed input and reports correlation gaps',()=>{
 assert.equal(validateJsonSample('{oops').ok,false);
 assert.equal(validateJsonSample('[]').ok,false);
 assert.equal(validateJsonSample('{"run_id":"1"}').hasRunId,true);
 assert.equal(validateJsonSample('{"x":1}').hasRunId,false);
});
test('secrets are authenticated, encrypted and not returned in plaintext',async()=>{
 const key='9'.repeat(64),url='https://hook.eu1.make.com/AbcdEFgh123';
 const enc=await encryptSecret(url,key);
 assert.equal(enc.includes(url),false);
 assert.equal(await decryptSecret(enc,key),url);
 await assert.rejects(decryptSecret(enc,'b'.repeat(64)));
 const broken=enc.slice(0,-2)+'xx';
 await assert.rejects(decryptSecret(broken,key));
 const token=newRandomString();assert.equal(token.length,64);
 assert.equal(constantTimeEqual(await sha256(token),await sha256(token)),true);
 assert.equal(constantTimeEqual(await sha256(token),await sha256('wrong')),false);
});
test('synthetic data never includes a real customer email',()=>{
 const out=syntheticPayload('run1',Date.UTC(2026,10,18),'https://example.com/callback');
 assert.equal(out.leadpath_test,true);
 assert.equal(out.sample_email,'test@example.invalid');
 assert.equal(out.run_id,'run1');
});
