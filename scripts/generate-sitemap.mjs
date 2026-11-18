import fs from 'node:fs';
const raw=process.argv[2];
if(!raw){console.error('Usage: node scripts/generate-sitemap.mjs https://YOUR-WORKER.workers.dev');process.exit(1);}
let base;try{const u=new URL(raw);if(u.protocol!=='https:'||!u.hostname||u.pathname!=='/'||u.search||u.hash)throw new Error('bad origin');base=u.origin;}catch{console.error('Provide a live HTTPS origin without a path.');process.exit(1);}
const routes=['/','/how-it-works','/features','/pricing','/checker','/docs','/faq','/contact','/privacy','/terms',
 '/docs/webflow-make','/docs/make-sheets','/docs/crm-missing','/docs/webhook-200','/docs/silent-failures','/docs/free-monitoring'];
const xml='<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'+routes.map(route=>`  <url><loc>${base}${route}</loc></url>`).join('\n')+'\n</urlset>\n';
fs.writeFileSync('public/sitemap.xml',xml);
fs.writeFileSync('public/robots.txt',`User-agent: *\nAllow: /\nDisallow: /dashboard\nDisallow: /account\nDisallow: /api/\nDisallow: /auth/\nSitemap: ${base}/sitemap.xml\n`);
console.log(`Generated sitemap and robots.txt for ${base}`);
