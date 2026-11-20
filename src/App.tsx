import React, { useEffect, useState } from 'react';
import { Activity, ArrowUpRight, ChevronRight, Github, Menu, Moon, Sun, Webhook } from 'lucide-react';
import Dashboard from './pages/Dashboard';
import { MarketingPage } from './pages/Marketing';
import Checker from './pages/Checker';
const PATH=window.location.pathname;
const items=[['How it works','/how-it-works'],['Features','/features'],['Pricing','/pricing'],['Docs','/docs']];
function useSeo(path:string) {
 useEffect(()=>{
  const names:Record<string,string>={'/':'Automated lead workflow monitoring','/how-it-works':'How synthetic verification works','/features':'Features','/pricing':'Pricing','/checker':'Free workflow checker','/docs':'Workflow documentation','/faq':'Frequently asked questions','/contact':'Contact','/privacy':'Privacy policy','/terms':'Terms of service','/login':'Sign in','/signup':'Create account','/forgot-password':'Forgot password','/reset-password':'Reset password','/verify-email':'Verify email','/resend-verification':'Resend verification','/dashboard':'Dashboard','/account':'Account'};
  document.title=`${names[path]||'Guide'} | LeadPath`;
  let canonical=document.querySelector('link[rel=canonical]') as HTMLLinkElement|null;
  if (!canonical) {canonical=document.createElement('link');canonical.rel='canonical';document.head.appendChild(canonical);}
  const publicRoutes=new Set(['/','/how-it-works','/features','/pricing','/checker','/docs','/faq','/contact','/privacy','/terms',
   '/docs/webflow-make','/docs/make-sheets','/docs/crm-missing','/docs/webhook-200','/docs/silent-failures','/docs/free-monitoring']);
  const publiclyIndexable=publicRoutes.has(path);
  canonical.href=location.origin+(publiclyIndexable?path:'/');
  let robots=document.querySelector('meta[name="robots"]') as HTMLMetaElement|null;
  if(!robots){robots=document.createElement('meta');robots.name='robots';document.head.appendChild(robots);}
  robots.content=publiclyIndexable?'index, follow':'noindex, nofollow';
  const descriptions:Record<string,string>={
   '/':'Monitor authorized Make to Google Sheets workflows and confirm delivery with secure callbacks. Free synthetic monitoring and JSON diagnostics.',
   '/how-it-works':'Learn how LeadPath checks an authorized Make webhook, Google Sheets write and matching confirmation callback.',
   '/features':'Explore delivery confirmation, six-hour synthetic monitoring, run history and failure and recovery alerts.',
   '/pricing':'LeadPath is currently free for one Make to Google Sheets monitor. Independent provider limits apply.',
   '/checker':'Validate JSON payloads and safe webhook URL formatting locally without sending network requests.',
   '/contact':'Contact LeadPath support about monitoring, login, account access or privacy requests.',
   '/privacy':'Learn what account and synthetic monitoring data LeadPath processes and how to manage your information.',
   '/terms':'Terms for using LeadPath synthetic webhook monitoring and free local workflow diagnostic tools.'
  };
  let description=document.querySelector('meta[name=description]') as HTMLMetaElement|null;
  if(description)description.content=descriptions[path]||'Get practical guidance on troubleshooting your Make to Google Sheets workflow with destination-confirmed monitoring.';
  const ogUrl=document.querySelector('meta[property="og:url"]') as HTMLMetaElement|null;
  if(ogUrl)ogUrl.content=canonical.href;
 },[path]);
}
export default function App() {
 const [dark,setDark]=useState(()=>localStorage.getItem('leadpath_theme')!=='light');
 const [open,setOpen]=useState(false);
 useSeo(PATH);
 useEffect(()=>{document.documentElement.dataset.theme=dark?'dark':'light';localStorage.setItem('leadpath_theme',dark?'dark':'light');},[dark]);
 const isApp=PATH==='/dashboard'||PATH==='/account';
 return <div className="app-shell">
  <header className="site-header"><div className="header-inner container">
   <a href="/" className="brand" aria-label="LeadPath home"><span className="brand-icon"><Activity size={19} strokeWidth={2.5}/></span><span>leadpath<span className="brand-period">.</span></span></a>
   <nav className={'top-nav '+(open?'visible':'')} aria-label="Main navigation">{items.map(([label,url])=><a key={url} href={url} className={PATH===url?'nav-current':''}>{label}</a>)}<a href="/checker">Free checker</a></nav>
   <div className="nav-actions"><button className="icon-button theme-toggle" onClick={()=>setDark(!dark)} aria-label={dark?'Switch to light mode':'Switch to dark mode'}>{dark?<Sun size={18}/>:<Moon size={18}/>}</button><a className="nav-login" href="/login">Log in</a><a className="btn btn-primary nav-cta" href="/signup">Get started <ArrowUpRight size={16}/></a><button className="icon-button mobile-menu" onClick={()=>setOpen(!open)} aria-expanded={open} aria-label="Toggle navigation"><Menu size={22}/></button></div>
  </div></header>
  <main>{isApp?<Dashboard page={PATH}/>:PATH==='/checker'?<Checker/>:<MarketingPage path={PATH}/>}</main>
  <footer className="site-footer"><div className="container footer-grid"><div><a href="/" className="brand"><span className="brand-icon"><Webhook size={17}/></span>leadpath<span className="brand-period">.</span></a><p>Know when a lead workflow stops confirming delivery.</p><span className="small muted">Authorized workflows · Synthetic monitoring · No real lead data</span></div><div><strong>Product</strong><a href="/features">Features</a><a href="/pricing">Pricing</a><a href="/checker">Free checker</a></div><div><strong>Resources</strong><a href="/docs">Documentation</a><a href="/how-it-works">How it works</a><a href="/faq">FAQ</a></div><div><strong>Company</strong><a href="/contact">Contact</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></div></div><div className="container footer-bottom"><span>© {new Date().getFullYear()} LeadPath · <a href="mailto:minty.12.shar@gmail.com">Support</a></span><span>Works with Make + Google Sheets <ChevronRight size={13}/></span></div></footer>
 </div>;
}
