/**
 * Build-time static HTML for every public LeadPath page.
 * Crawlable content, metadata, canonical and structured data all exist before JS runs.
 * Account routes remain private, noindex, client-rendered shells.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import React from 'react';
import {renderToString} from 'react-dom/server';
import {createServer} from 'vite';

const dist=path.resolve('dist');
const template=await fs.readFile(path.join(dist,'index.html'),'utf8');
const server=await createServer({server:{middlewareMode:true},appType:'custom',logLevel:'error'});
const escapeHtml=(s)=>String(s).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const json=(value)=>JSON.stringify(value).replaceAll('<','\\u003c');
const replaceTag=(html,replacement,regex,label)=>{
 if(!regex.test(html))throw Error('Expected Vite HTML template tag missing: '+label);
 return html.replace(regex,replacement);
};
const write=async(route,html)=>{
 const file=route==='/'?'index.html':route.slice(1)+'.html';
 const full=path.join(dist,file);
 await fs.mkdir(path.dirname(full),{recursive:true});
 await fs.writeFile(full,html);
};
function schemaFor(route,meta,origin){
 const canonical=origin+route;
 const site={'@type':'WebSite','@id':origin+'/#website',name:'LeadPath',url:origin+'/',description:'Destination-confirmed monitoring for authorized Make to Google Sheets workflows'};
 const graph=[site,{'@type':'WebPage','@id':canonical+'#webpage',url:canonical,name:meta.title,description:meta.description,isPartOf:{'@id':site['@id']},inLanguage:'en'}];
 if(route==='/'){
  graph.push({'@type':'WebApplication','@id':origin+'/#application',name:'LeadPath',url:origin+'/',applicationCategory:'BusinessApplication',operatingSystem:'Web',description:meta.description,offers:{'@type':'Offer',price:'0',priceCurrency:'USD'}});
 }
 if(route.startsWith('/docs/')){
  graph.push({'@type':'BreadcrumbList','@id':canonical+'#breadcrumbs',itemListElement:[
    {'@type':'ListItem',position:1,name:'Home',item:origin+'/'},
    {'@type':'ListItem',position:2,name:'Documentation',item:origin+'/docs'},
    {'@type':'ListItem',position:3,name:meta.title.split(' | ')[0],item:canonical}
  ]});
 }
 return {'@context':'https://schema.org','@graph':graph};
}
function headFor(original,route,meta,origin,indexable){
 const canonical=origin+route;
 let h=original;
 h=replaceTag(h,'<title>'+escapeHtml(meta.title)+'</title>',/<title>[^<]*<\/title>/,'title');
 h=replaceTag(h,'<meta name="description" content="'+escapeHtml(meta.description)+'"/>',/<meta name="description"[^>]*\/>/,'description');
 h=replaceTag(h,'<meta property="og:title" content="'+escapeHtml(meta.title)+'"/>',/<meta property="og:title"[^>]*\/>/,'og title');
 h=replaceTag(h,'<meta property="og:description" content="'+escapeHtml(meta.description)+'"/>',/<meta property="og:description"[^>]*\/>/,'og description');
 h=replaceTag(h,'<meta property="og:url" content="'+escapeHtml(canonical)+'"/>',/<meta property="og:url"[^>]*\/>/,'og URL');
 // No misleading home-page canonical on private/noindex pages.
 h=replaceTag(h,indexable?'<link rel="canonical" href="'+escapeHtml(canonical)+'"/>':'',/<link rel="canonical"[^>]*\/>/,'canonical');
 const data=indexable?'<script type="application/ld+json">'+json(schemaFor(route,meta,origin))+'</script>':'';
 h=h.replace('</head>','<meta name="robots" content="'+(indexable?'index, follow':'noindex, nofollow')+'"/><meta name="twitter:title" content="'+escapeHtml(meta.title)+'"/><meta name="twitter:description" content="'+escapeHtml(meta.description)+'"/>'+data+'</head>');
 return h;
}
try{
 const [{default:App},{PUBLIC_SEO,PRIVATE_ROUTES,SITE_ORIGIN}]=await Promise.all([
  server.ssrLoadModule('/src/App.tsx'),server.ssrLoadModule('/src/seo.ts')
 ]);
 const publicRoutes=Object.entries(PUBLIC_SEO);
 for(const [route,meta] of publicRoutes){
  const markup=renderToString(React.createElement(App,{initialPath:route}));
  const base=headFor(template,route,meta,SITE_ORIGIN,true);
  if(!base.includes('<div id="root"></div>'))throw Error('React root not found in Vite output');
  await write(route,base.replace('<div id="root"></div>','<div id="root" data-prerendered="true">'+markup+'</div>'));
 }
 for(const route of PRIVATE_ROUTES){
  const title=route==='/dashboard'?'Dashboard | LeadPath':route==='/billing'?'Plan & billing | LeadPath':route==='/account'?'Account settings | LeadPath':'Secure account access | LeadPath';
  await write(route,headFor(template,route,{title,description:'Private LeadPath account page.'},SITE_ORIGIN,false));
 }
 const sitemap='<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'+publicRoutes.map(([p])=>'  <url><loc>'+escapeHtml(SITE_ORIGIN+p)+'</loc></url>').join('\n')+'\n</urlset>\n';
 await fs.writeFile(path.join(dist,'sitemap.xml'),sitemap);
 await fs.writeFile(path.join(dist,'robots.txt'),[
  'User-agent: *','Allow: /','Disallow: /api/','Disallow: /auth/','Sitemap: '+SITE_ORIGIN+'/sitemap.xml',''
 ].join('\n'));
 await fs.writeFile(path.join(dist,'404.html'),'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Page not found | LeadPath</title></head><body style="font-family:system-ui,sans-serif;max-width:48rem;margin:6rem auto;padding:1rem"><h1>404 — Page not found</h1><p>This LeadPath page does not exist.</p><a href="/">Go to LeadPath home</a> · <a href="/docs">Documentation</a></body></html>');
 console.log('Generated '+publicRoutes.length+' prerendered indexable pages, '+PRIVATE_ROUTES.length+' noindex app shells, sitemap and 404.');
} finally {await server.close();}
