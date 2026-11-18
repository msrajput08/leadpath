import React, { useState } from 'react';
import { ArrowRight, CheckCircle2, Code2, LockKeyhole, XCircle, ShieldCheck } from 'lucide-react';
const SAMPLE='{"run_id":"00000000-0000-4000-8000-000000000000","leadpath_test":true,"sample_email":"test@example.invalid"}';
type Result={pass:boolean;heading:string;details:string[]};
export default function Checker(){
 const [url,setUrl]=useState(''); const [body,setBody]=useState(SAMPLE); const [result,setResult]=useState<Result|null>(null);
 function examine(){
  const lines:string[]=[];let pass=true;
  if(url.trim()){
   try {const u=new URL(url); if(u.protocol!=='https:') {pass=false; lines.push('Your endpoint is not HTTPS. Require TLS.');}
    else lines.push('Endpoint uses HTTPS (format only; no network call was made).');
    if(u.username||u.password){pass=false;lines.push('URL embeds username/password. Remove these credentials.');}
    if(/^hook\.[a-z0-9-]+\.make\.com$/.test(u.hostname)&&/^\/[A-Za-z0-9_-]{8,}$/.test(u.pathname)) lines.push('Looks like an official Make regional webhook URL.');
    else lines.push('Not a recognized Make webhook; LeadPath scheduled monitoring currently supports Make URLs only.');
   } catch {pass=false;lines.push('Endpoint URL is not valid.');}
  } else lines.push('No endpoint supplied. JSON payload checks still run without one.');
  if(body.length>10000){pass=false;lines.push('JSON sample exceeds 10 KB.');}
  else try {const o=JSON.parse(body);if(!o || typeof o!=='object' || Array.isArray(o)){pass=false;lines.push('JSON root must be an object.');}
    else {lines.push(`Valid JSON object with ${Object.keys(o).length} top-level field(s).`);
     if(typeof o.run_id==='string') lines.push('run_id exists; this can correlate delivery confirmations.');
     else lines.push('No string run_id field: a confirmation callback cannot correlate this test.');
     if(o.leadpath_test!==true)lines.push('Consider leadpath_test=true to mark synthetic records.');
    }
  } catch(e){pass=false;lines.push('Invalid JSON: '+(e instanceof Error?e.message:'Parse error'));}
  lines.push('No request was sent. Response code, Make execution and Google Sheets delivery remain unverified.');
  setResult({pass,heading:pass?'Local format checks complete':'Issues found in input',details:lines});
 }
 return <><div className="page-banner container"><span className="eyebrow"><Code2 size={14}/> NO SIGNUP REQUIRED</span><h1>Free workflow checker<span className="brand-period">.</span></h1><p className="lead">Find malformed webhook payloads and unsafe endpoint formatting before the next lead gets lost.</p></div>
 <section className="container checker-layout"><div className="panel checker-form"><div className="section-kicker">01 / VALIDATE</div><label className="form-label" htmlFor="endpoint">Webhook URL <span className="muted">(optional)</span></label><input id="endpoint" type="url" placeholder="https://hook.eu1.make.com/…" value={url} onChange={e=>setUrl(e.target.value)} autoComplete="off"/>
 <label className="form-label" htmlFor="payload">Example JSON payload</label><textarea id="payload" spellCheck={false} rows={8} value={body} onChange={e=>setBody(e.target.value)}/>
 <div className="row-inline space-between"><span className="small muted"><LockKeyhole size={13}/> Runs in your browser — no form submission</span><button className="btn btn-primary" onClick={examine}>Analyze payload <ArrowRight size={16}/></button></div></div>
 <div className="panel checker-results"><div className="section-kicker">02 / RESULTS</div>{result?<><div className="result-heading">{result.pass?<CheckCircle2 size={23}/>:<XCircle size={23}/>}<strong>{result.heading}</strong></div><ul className="result-list">{result.details.map((l,i)=><li key={i}>{l}</li>)}</ul><a className="text-link" href="/how-it-works">How to verify actual delivery <ArrowRight size={15}/></a></>:<div className="empty-result"><ShieldCheck size={34}/><h3>Your results appear here</h3><p>We'll check syntax and explain what is — and isn't — verifiable without contacting the destination.</p></div>}</div></section>
 <section className="container small-disclaimer"><strong>What's not tested:</strong> This free checker does not contact the URL, send a synthetic lead, read your Google Sheet or claim that a workflow delivered anything. End-to-end delivery verification requires an authorized monitor and a confirmation callback.</section>
 </>;
}
