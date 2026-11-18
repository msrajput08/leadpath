import React,{useEffect,useState} from 'react';
import {ArrowRight,Github} from 'lucide-react';
export default function AuthOptions(){
 const [status,setStatus]=useState<{google_auth_configured:boolean;github_auth_configured:boolean}|null>(null);
 const [failed,setFailed]=useState(false);
 useEffect(()=>{fetch('/api/public/status').then(async r=>{if(!r.ok)throw new Error('unavailable');setStatus(await r.json());}).catch(()=>setFailed(true));},[]);
 if(!status)return <p className="muted small">{failed?'Sign-in configuration could not be checked.':'Checking available sign-in providers…'}</p>;
 if(!status.google_auth_configured&&!status.github_auth_configured)return <div className="notice"><span>Sign-in is not configured on this deployment. The owner needs to set up Google or GitHub OAuth credentials.</span></div>;
 return <div className="auth-options">
  {status.google_auth_configured&&<a className="btn btn-primary btn-block" href="/auth/google/start">Continue with Google <ArrowRight size={17}/></a>}
  {status.github_auth_configured&&<a className="btn btn-secondary btn-block" href="/auth/github/start"><Github size={17}/> Continue with GitHub</a>}
 </div>;
}
