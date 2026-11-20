import React, { useEffect, useState } from 'react';
import { Activity, ArrowUpRight, ChevronRight, Github, Menu, Moon, Sun, Webhook } from 'lucide-react';
import Dashboard from './pages/Dashboard';
import { MarketingPage } from './pages/Marketing';
import Checker from './pages/Checker';
import {pageSeo,SITE_ORIGIN} from './seo';
const items=[['How it works','/how-it-works'],['Features','/features'],['Pricing','/pricing'],['Docs','/docs']];
function useSeo(path:string){
 useEffect(()=>{
  const meta=pageSeo(path);
  document.title=meta?.title||(path==='/dashboard'?'Dashboard | LeadPath':path==='/account'?'Account settings | LeadPath':'Secure account access | LeadPath');
  let canonical=document.querySelector('link[rel="canonical"]') as HTMLLinkElement|null;
  if(meta){
   if(!canonical){canonical=document.createElement('link');canonical.rel='canonical';document.head.appendChild(canonical);}
   canonical.href=SITE_ORIGIN+path;
  }else canonical?.remove();
  let robots=document.querySelector('meta[name="robots"]') as HTMLMetaElement|null;
  if(!robots){robots=document.createElement('meta');robots.name='robots';document.head.appendChild(robots);}
  robots.content=meta?'index, follow':'noindex, nofollow';
  let desc=document.querySelector('meta[name="description"]') as HTMLMetaElement|null;
  if(meta&&desc)desc.content=meta.description;
  for(const [property,value] of [['og:title',meta?.title],['og:description',meta?.description],['og:url',meta?SITE_ORIGIN+path:undefined]]){
   const tag=document.querySelector('meta[property="'+property+'"]') as HTMLMetaElement|null;
   if(tag&&value)tag.content=value;
  }
 },[path]);
}
export default function App({initialPath}:{initialPath?:string}={}) {
 const route=initialPath??(typeof window!=='undefined'?window.location.pathname:'/');
 const [dark,setDark]=useState(true);
 const [open,setOpen]=useState(false);
 useSeo(route);
 useEffect(()=>{if(localStorage.getItem('leadpath_theme')==='light')setDark(false);},[]);
 useEffect(()=>{document.documentElement.dataset.theme=dark?'dark':'light';localStorage.setItem('leadpath_theme',dark?'dark':'light');},[dark]);
 const isApp=route==='/dashboard'||route==='/account';
 return <div className="app-shell">
  <header className="site-header"><div className="header-inner container">
   <a href="/" className="brand" aria-label="LeadPath home"><span className="brand-icon"><Activity size={19} strokeWidth={2.5}/></span><span>leadpath<span className="brand-period">.</span></span></a>
   <nav className={'top-nav '+(open?'visible':'')} aria-label="Main navigation">{items.map(([label,url])=><a key={url} href={url} className={route===url?'nav-current':''}>{label}</a>)}<a href="/checker">Free checker</a></nav>
   <div className="nav-actions"><button className="icon-button theme-toggle" onClick={()=>setDark(!dark)} aria-label={dark?'Switch to light mode':'Switch to dark mode'}>{dark?<Sun size={18}/>:<Moon size={18}/>}</button><a className="nav-login" href="/login">Log in</a><a className="btn btn-primary nav-cta" href="/signup">Get started <ArrowUpRight size={16}/></a><button className="icon-button mobile-menu" onClick={()=>setOpen(!open)} aria-expanded={open} aria-label="Toggle navigation"><Menu size={22}/></button></div>
  </div></header>
  <main>{isApp?<Dashboard page={route}/>:route==='/checker'?<Checker/>:<MarketingPage path={route}/>}</main>
  <footer className="site-footer"><div className="container footer-grid"><div><a href="/" className="brand"><span className="brand-icon"><Webhook size={17}/></span>leadpath<span className="brand-period">.</span></a><p>Know when a lead workflow stops confirming delivery.</p><span className="small muted">Authorized workflows · Synthetic monitoring · No real lead data</span></div><div><strong>Product</strong><a href="/features">Features</a><a href="/pricing">Pricing</a><a href="/checker">Free checker</a></div><div><strong>Resources</strong><a href="/docs">Documentation</a><a href="/how-it-works">How it works</a><a href="/faq">FAQ</a></div><div><strong>Company</strong><a href="/contact">Contact</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></div></div><div className="container footer-bottom"><span>© {new Date().getFullYear()} LeadPath · <a href="mailto:minty.12.shar@gmail.com">Support</a></span><span>Works with Make + Google Sheets <ChevronRight size={13}/></span></div></footer>
 </div>;
}
