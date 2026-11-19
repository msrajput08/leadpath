import React, {useEffect,useState} from 'react';
import {ArrowRight,Facebook,Github,Mail} from 'lucide-react';

type AuthStatus={
 google_auth_configured:boolean;
 github_auth_configured:boolean;
 facebook_auth_configured?:boolean;
 x_auth_configured?:boolean;
 email_auth_configured?:boolean;
};

export default function AuthOptions(){
 const [status,setStatus]=useState<AuthStatus|null>(null);
 const [failed,setFailed]=useState(false);
 const [email,setEmail]=useState('');
 const [code,setCode]=useState('');
 const [step,setStep]=useState<'email'|'code'>('email');
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const [message,setMessage]=useState('');
 useEffect(()=>{
  fetch('/api/public/status',{credentials:'same-origin'}).then(async response=>{
   if(!response.ok)throw new Error('Unavailable');
   setStatus(await response.json());
  }).catch(()=>setFailed(true));
 },[]);
 async function submit(path:string,body:Record<string,string>){
  setBusy(true);setError('');
  try{
   const res=await fetch(path,{
    method:'POST',credentials:'same-origin',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(body)
   });
   const data=await res.json().catch(()=>({}));
   if(!res.ok)throw new Error(data.error||'Sign-in could not be completed');
   if(path.endsWith('/verify')){
    location.assign('/dashboard');
   }else{
    setStep('code');setMessage('Check your inbox for the 6-digit code. It expires in 10 minutes.');
   }
  }catch(err){
   setError(err instanceof Error?err.message:'Sign-in is unavailable');
  }finally{setBusy(false);}
 }
 if(!status)return <p className="muted small">{failed?'Could not check the available login methods.':'Checking available sign-in providers…'}</p>;
 const available=!!(status.google_auth_configured||status.github_auth_configured||
  status.facebook_auth_configured||status.x_auth_configured||status.email_auth_configured);
 if(!available)return <div className="notice"><span>No sign-in providers are configured on this deployment. The operator must enable an OAuth provider or passwordless email.</span></div>;
 return <div className="auth-options">
  {status.google_auth_configured&&<a className="btn btn-primary btn-block" href="/auth/google/start">Continue with Google <ArrowRight size={17}/></a>}
  {status.facebook_auth_configured&&<a className="btn btn-secondary btn-block" href="/auth/facebook/start"><Facebook size={17}/> Continue with Facebook</a>}
  {status.x_auth_configured&&<a className="btn btn-secondary btn-block" href="/auth/x/start"><strong aria-hidden="true">𝕏</strong> Continue with X</a>}
  {status.github_auth_configured&&<a className="btn btn-secondary btn-block" href="/auth/github/start"><Github size={17}/> Continue with GitHub</a>}
  {status.email_auth_configured&&<div className="email-auth-section">
   <div className="auth-divider"><span>or sign in with email</span></div>
   {step==='email'?
    <form onSubmit={event=>{event.preventDefault();void submit('/auth/email/request',{email});}}>
     <label className="form-label" htmlFor="login-email">Email address</label>
     <input id="login-email" type="email" value={email} required autoComplete="email"
      maxLength={254} placeholder="you@example.com" onChange={event=>setEmail(event.target.value)}/>
     <button className="btn btn-secondary btn-block" type="submit" disabled={busy}><Mail size={17}/>{busy?'Sending code…':'Send sign-in code'}</button>
    </form>
   :<form onSubmit={event=>{event.preventDefault();void submit('/auth/email/verify',{email,code});}}>
     <p className="small muted">{message} Sent to <strong>{email}</strong>.</p>
     <label className="form-label" htmlFor="login-code">6-digit code</label>
     <input id="login-code" type="text" value={code} required inputMode="numeric" autoComplete="one-time-code"
      maxLength={6} pattern="[0-9]{6}" placeholder="123456" onChange={event=>setCode(event.target.value.replace(/\D/g,''))}/>
     <button className="btn btn-primary btn-block" type="submit" disabled={busy||code.length!==6}>{busy?'Verifying…':'Verify and sign in'} <ArrowRight size={17}/></button>
     <button type="button" className="btn btn-secondary btn-block" onClick={()=>{setStep('email');setCode('');setError('');}}>Use a different email or resend</button>
    </form>}
   {error&&<p role="alert" className="small" style={{color:'var(--error)'}}>{error}</p>}
  </div>}
  <p className="small muted">Use the same sign-in method as before to access your existing workspace. Different providers are not automatically linked, even when email addresses match.</p>
 </div>;
}
