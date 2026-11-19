import React,{useEffect,useState} from 'react';
import {Activity,ArrowRight,CheckCircle2,Eye,EyeOff,Github,KeyRound,LockKeyhole,Mail,ShieldCheck,Sparkles} from 'lucide-react';

type Mode='signup'|'login'|'forgot'|'verify'|'reset'|'sent'|'verified'|'complete'|'resend';
type AuthStatus={
 google_auth_configured:boolean;
 github_auth_configured:boolean;
 password_auth_configured?:boolean;
};
type Action='signup'|'forgot'|'resend';
const titles:Record<Mode,string>={
 signup:'A better way to stay ahead.',login:'Welcome back.',forgot:'Reset your password.',
 verify:'Confirm your email.',reset:'Choose a new password.',sent:'Check your inbox.',
 verified:'Email verified.',complete:'Password updated.',resend:'Resend verification.'
};

export default function AuthOptions({initialMode='login'}:{initialMode?:Mode}){
 const [mode,setMode]=useState<Mode>(initialMode);
 const [status,setStatus]=useState<AuthStatus|null>(null);
 const [statusError,setStatusError]=useState(false);
 const [name,setName]=useState('');
 const [email,setEmail]=useState('');
 const [password,setPassword]=useState('');
 const [confirm,setConfirm]=useState('');
 const [showPassword,setShowPassword]=useState(false);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const [action,setAction]=useState<Action>('signup');
 const [token]=useState(()=>new URLSearchParams(window.location.search).get('token')||'');
 useEffect(()=>{
  fetch('/api/public/status',{credentials:'same-origin'})
   .then(async r=>{if(!r.ok)throw Error('Unavailable');setStatus(await r.json());})
   .catch(()=>setStatusError(true));
 },[]);
 useEffect(()=>{
  if(initialMode==='verify'||initialMode==='reset'){
   // Avoid carrying reset/verification tokens into browser history, referrers or screenshots.
   window.history.replaceState(null,'',window.location.pathname);
  }
 },[initialMode]);
 function change(next:Mode){setMode(next);setError('');setPassword('');setConfirm('');}
 async function send(path:string,body:Record<string,string>,done:()=>void){
  setBusy(true);setError('');
  try {
   const r=await fetch(path,{
    method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
   });
   const data=await r.json().catch(()=>({}));
   if(!r.ok)throw Error(data.error||'Request failed. Please try again.');
   done();
  }catch(e){setError(e instanceof Error?e.message:'Request failed. Please try again.');}
  finally{setBusy(false);}
 }
 function submit(event:React.FormEvent){
  event.preventDefault();
  if(mode==='signup'){
   if(password!==confirm){setError('Passwords do not match.');return;}
   setAction('signup');
   void send('/auth/password/signup',{name,email,password},()=>change('sent'));
  } else if(mode==='login'){
   void send('/auth/password/login',{email,password},()=>window.location.assign('/dashboard'));
  } else if(mode==='forgot'){
   setAction('forgot');
   void send('/auth/password/forgot',{email},()=>change('sent'));
  } else if(mode==='resend'){
   setAction('resend');
   void send('/auth/password/resend',{email},()=>change('sent'));
  } else if(mode==='reset'){
   if(password!==confirm){setError('Passwords do not match.');return;}
   void send('/auth/password/reset',{token,password},()=>change('complete'));
  } else if(mode==='verify'){
   void send('/auth/password/verify',{token},()=>change('verified'));
  }
 }
 const configured=Boolean(status?.password_auth_configured);
 const socialAvailable=Boolean(status?.google_auth_configured||status?.github_auth_configured);
 const isPasswordForm=mode==='signup'||mode==='login'||mode==='reset';
 const isEmailForm=mode==='signup'||mode==='login'||mode==='forgot'||mode==='resend';
 const showForm=mode!=='sent'&&mode!=='verified'&&mode!=='complete';
 return <div className="auth-scene">
  <div className="auth-frame">
   <aside className="auth-story">
    <div className="auth-story-top"><span className="auth-story-symbol"><Activity size={22}/></span><strong>leadpath<span className="auth-dot">.</span></strong></div>
    <div className="auth-story-copy">
     <span className="auth-overline"><span className="auth-status-dot"/> THE QUIET CONFIDENCE OF KNOWING</span>
     <h2>Every lead<br/>deserves to <em>arrive.</em></h2>
     <p>Beautifully simple monitoring for your most important workflows. Catch the failures nobody else sees.</p>
     <div className="auth-story-card">
      <span className="auth-story-check"><CheckCircle2 size={18}/></span>
      <div><strong>More certainty. Less checking.</strong><small>From webhook to destination confirmation.</small></div>
     </div>
    </div>
    <div className="auth-story-foot"><ShieldCheck size={15}/> Protected workspace · Built for clarity</div>
   </aside>
   <section className="auth-form-side">
    <div className="auth-form-top"><span className="auth-small-brand"><Activity size={17}/> leadpath.</span><a href="/" className="auth-home-link">Back to website <ArrowRight size={14}/></a></div>
    <div className="auth-form-inner">
     <span className="auth-eyebrow"><Sparkles size={13}/> YOUR WORKSPACE STARTS HERE</span>
     <h1>{titles[mode]}</h1>
     <p className="auth-subtitle">{mode==='signup'?'Join LeadPath and get a clearer picture of your lead automation.'
      :mode==='login'?'Access your monitoring dashboard and keep everything on track.'
      :mode==='forgot'?'Enter your account email and we will send a secure, single-use reset link.'
      :mode==='reset'?'Make it memorable to you and hard for anyone else to guess.'
      :mode==='verify'?'Use the secure button below to confirm this email address.'
      :mode==='resend'?'We will send a fresh verification link if your account is awaiting verification.'
      :mode==='sent'?'If your address is eligible, a secure link will arrive shortly. Please check Spam too.'
      :mode==='verified'?'Your account is ready. Sign in with your email and password.'
      :'Sign in with your new password. Other active sessions have been signed out.'}</p>
     {(mode==='login'||mode==='signup')&&<div className="auth-tabs">
      <a href="/signup" className={mode==='signup'?'selected':''}>Create account</a>
      <a href="/login" className={mode==='login'?'selected':''}>Log in</a>
     </div>}
     {showForm&&<form className="auth-fields" onSubmit={submit}>
      {mode==='signup'&&<label htmlFor="lp-name">Full name
       <input id="lp-name" type="text" required maxLength={120} minLength={2}
        autoComplete="name" value={name} onChange={e=>setName(e.target.value)} placeholder="Your full name"/>
      </label>}
      {isEmailForm&&<label htmlFor="lp-email">Email address
       <input id="lp-email" type="email" required maxLength={254} autoComplete="email"
        value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com"/>
      </label>}
      {isPasswordForm&&<label htmlFor="lp-password">{mode==='reset'?'New password':'Password'}
       <span className="auth-password-wrap">
        <input id="lp-password" type={showPassword?'text':'password'} required minLength={mode==='login'?1:12} maxLength={128}
         autoComplete={mode==='login'?'current-password':'new-password'}
         value={password} onChange={e=>setPassword(e.target.value)} placeholder={mode==='signup'?'At least 12 characters':'Enter your password'}/>
        <button type="button" aria-label={showPassword?'Hide password':'Show password'} onClick={()=>setShowPassword(!showPassword)}>
         {showPassword?<EyeOff size={17}/>:<Eye size={17}/>}
        </button>
       </span>
      </label>}
      {(mode==='signup'||mode==='reset')&&<label htmlFor="lp-confirm">Confirm password
       <input id="lp-confirm" type={showPassword?'text':'password'} required minLength={12} maxLength={128}
        autoComplete="new-password" value={confirm} onChange={e=>setConfirm(e.target.value)} placeholder="Enter it again"/>
      </label>}
      {(mode==='signup'||mode==='reset')&&<p className="auth-hint"><LockKeyhole size={14}/> Use at least 12 characters. Never reuse a password from another site.</p>}
      {mode==='login'&&<div className="auth-forgot"><a href="/forgot-password">Forgot password?</a></div>}
      {mode==='verify'&&!token&&<p className="auth-callout">Your link is missing. Request a new verification email below.</p>}
      <button type="submit" className="auth-submit" disabled={busy||!configured||(mode==='verify'&&!token)||(mode==='reset'&&!token)}>
       {busy?'Please wait…':mode==='signup'?'Create free account':mode==='login'?'Log in':mode==='forgot'?'Send reset link':mode==='resend'?'Resend verification link':mode==='verify'?'Verify email':'Update password'}
       {!busy&&<ArrowRight size={17}/>}
      </button>
     </form>}
     {error&&<p className="auth-error" role="alert">{error}</p>}
     {statusError&&<p className="auth-callout">Could not check available login methods. Refresh the page to retry.</p>}
     {status&&!configured&&<p className="auth-callout">Email/password sign-in will be available after the verified email sender is configured. Google and GitHub sign-in remain available.</p>}
     {mode==='sent'&&<div className="auth-result"><Mail size={23}/><strong>Check your email</strong><p>Verification and reset links may take a moment to arrive.</p><button className="auth-link-button" onClick={()=>change(action==='signup'||action==='resend'?'resend':'forgot')}>Didn't receive it? {action==='forgot'?'Try again':'Resend verification'}</button></div>}
     {(mode==='verified'||mode==='complete')&&<a className="auth-submit auth-result-link" href="/login">Continue to login <ArrowRight size={17}/></a>}
     {(mode==='forgot'||mode==='resend'||mode==='verify'||mode==='reset')&&<p className="auth-navigation"><a href="/login">Back to login</a></p>}
     {(mode==='signup'||mode==='login')&&<React.Fragment>
      <div className="auth-or"><span>or continue with</span></div>
      <div className="auth-social">
       {status?.google_auth_configured&&<a href="/auth/google/start" className="auth-social-btn"><span className="auth-google-letter">G</span> Google</a>}
       {status?.github_auth_configured&&<a href="/auth/github/start" className="auth-social-btn"><Github size={18}/> GitHub</a>}
      </div>
      {status&&!socialAvailable&&!configured&&<p className="auth-callout">No sign-in providers are configured on this deployment.</p>}
      <p className="auth-disclosure">Using a different login provider creates a separate workspace until you explicitly link accounts. By continuing you agree to our <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>.</p>
     </React.Fragment>}
     {mode==='login'&&<p className="auth-navigation">New to LeadPath? <a href="/signup">Create an account</a></p>}
     {mode==='signup'&&<p className="auth-navigation">Already have an account? <a href="/login">Log in</a></p>}
     {mode==='verified'&&<p className="auth-navigation"><a href="/login">Return to sign in</a></p>}
     {mode==='verify'&&!token&&<p className="auth-navigation"><a href="/resend-verification">Request a fresh link</a></p>}
    </div>
    <div className="auth-form-bottom"><KeyRound size={14}/> Secure sign-in · No passwords shared with social providers</div>
   </section>
  </div>
 </div>;
}
