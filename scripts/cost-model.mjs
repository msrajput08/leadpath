// Planning scenario, not a claim about current scheduler capacity or an invoice.
// Rates retrieved 2026-11-20; assumptions and official links: docs/subscription-costs.md.
export function estimate(users,{mixed=true,writesPerCheck=30,bytesPerCheck=3000}={}){
 const mix=mixed?{free:.8,starter:.15,pro:.05}:{free:1,starter:0,pro:0};
 const dailyChecks=users*(mix.free*4+mix.starter*5*24+mix.pro*25*96);
 const monthlyChecks=dailyChecks*30;
 const requests=monthlyChecks+users*20*30; // one callback per check + signed-in API usage
 const writes=monthlyChecks*writesPerCheck+users*10*30;
 const reads=monthlyChecks*100+users*3000*30;
 const storageGB=dailyChecks*90*bytesPerCheck/1e9;
 const cpuMs=requests*5;
 const workers=5+Math.max(0,requests-1e7)/1e6*.30+Math.max(0,cpuMs-3e7)/1e6*.02;
 const d1Writes=Math.max(0,writes-5e7)/1e6;
 const d1Reads=Math.max(0,reads-25e9)/1e6*.001;
 const d1Storage=Math.max(0,storageGB-5)*.75;
 return {users,dailyChecks,monthlyChecks,monthlyWrites:writes,storageGB,workers,d1Writes,d1Reads,d1Storage,
  cloudflareTotal:workers+d1Writes+d1Reads+d1Storage,
  paddleFees:users*(mix.starter*(9*.05+.5)+mix.pro*(29*.05+.5)),
  revenue:users*(mix.starter*9+mix.pro*29)};
}
if(import.meta.url===`file://${process.argv[1]}`)console.table([100,1000,10000].map(n=>estimate(n)));
