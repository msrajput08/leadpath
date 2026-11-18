import { copyFileSync } from 'node:fs';

copyFileSync('worker/security.mjs', '.test-build/security.mjs');
