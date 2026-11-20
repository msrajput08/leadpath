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
  canonical.href=location.origin+path;
  let description=document.querySelector('meta[name=description]') as HTMLMetaElement|null;
  if (description) description.content=path==='/checker'?'Validate JSON payloads and inspect safe webhook URL format without sending requests.':'Verify your Make to Google Sheets automation with a destination-confirmed synthetic monitoring run.';
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
  <footer className="site-footer"><div className="container footer-grid"><div><a href="/" className="brand"><span className="brand-icon"><Webhook size={17}/></span>leadpath<span className="brand-period">.</span></a><p>Never lose a lead to a broken workflow.</p><span className="small muted">Built for transparent, permission-based testing.</span></div><div><strong>Product</strong><a href="/features">Features</a><a href="/pricing">Pricing</a><a href="/checker">Free checker</a></div><div><strong>Resources</strong><a href="/docs">Documentation</a><a href="/how-it-works">How it works</a><a href="/faq">FAQ</a></div><div><strong>Company</strong><a href="/contact">Contact</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></div></div><div className="container footer-bottom"><span>© {new Date().getFullYear()} LeadPath · Early access MVP</span><span>Works with Make + Google Sheets <ChevronRight size={13}/></span></div></footer>
 </div>;
}
