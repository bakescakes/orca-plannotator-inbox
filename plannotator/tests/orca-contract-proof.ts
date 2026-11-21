/** Orca build gate: the real patched Inbox routes in Orca mode against an inert fake bridge, including owner-only tailnet access. Run with Bun in the patched source tree. */
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync,realpathSync} from "node:fs";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {tmpdir} from "node:os";

const root=realpathSync(mkdtempSync(join(tmpdir(),"orca-contract-proof-")));
const data=join(root,"inbox"),state=join(root,"state"),project=join(root,"empty-native-project");
const secondProject=join(root,"second-native-project");
for(const path of [data,state,project,secondProject])mkdirSync(path,{recursive:true});
const key=Buffer.alloc(32,17),magic="acceptance.tail0000.ts.net";
const owner="owner@example.invalid",guest="guest@example.invalid";
const projects=[{name:"Empty native project",root:project}];
let authorized=true,catalogReads=0,healthReads=0,checks=0;
const nativeSessions:Record<string,unknown>={};
const check=(condition:unknown,message:string)=>{checks++;if(!condition)throw Error(message);};
writeFileSync(join(state,"link-key"),key,{mode:0o600});
const sidecar=Bun.serve({hostname:"127.0.0.1",port:0,fetch(request){
  authorized&&=request.headers.get("authorization")==="Bearer "+key.toString("hex");
  const path=new URL(request.url).pathname;
  if(path==="/api/lifecycle/catalog"){
    catalogReads++;
    return Response.json({ok:true,version:1,projects,workspaces:[],providers:[],sessions:nativeSessions});
  }
  if(path==="/api/health"){
    healthReads++;
    return Response.json({version:1,level:"ready",fresh:true,connected:1,conversations:1,delivered:0,waiting:0,blocked:[],
      routes:[{session:"private-native-session"}],canonicalInbox:data,debug:"private-diagnostic"});
  }
  return Response.json({error:"Unexpected inert bridge path"},{status:404});
}});
writeFileSync(join(state,"navigation.json"),JSON.stringify({version:1,port:sidecar.port}),{mode:0o600});
const config=join(root,"orca-config.json");
writeFileSync(config,JSON.stringify({v:1,canonicalDataDir:data,dataDirs:[data],stateDir:state,mcpCommand:[join(root,"inert-mcp")],
  upgradeCommand:[join(root,"inert-updater")],upgradeStateFile:join(state,"update-state.json"),upgradeBackoffMs:60000}),{mode:0o600});
writeFileSync(join(data,"config.json"),JSON.stringify({inboxTailscale:true,inboxTailscaleAllow:[guest]}),{mode:0o600});
// The build runner supplies an isolated HOME before Bun starts.
Object.assign(process.env,{PLANNOTATOR_ORCA_MODE:"1",PLANNOTATOR_ORCA_CONFIG:config,PLANNOTATOR_DATA_DIR:data,
  PLANNOTATOR_TEST_SANDBOX:"1",PLANNOTATOR_INBOX_TAILSCALE:"1",PLANNOTATOR_INBOX_CONNECT:"0",PLANNOTATOR_INBOX_NOTES:"0",
  PLANNOTATOR_UPDATE_CHECK:"0",PLANNOTATOR_AUTO_UPDATE:"0",NO_BROWSER:"1",PLANNOTATOR_BROWSER:"/usr/bin/true",
  NO_ANON_PING:"1",PLANNOTATOR_FEEDBACK_HISTORY:"0"});
const published=new Map<number,string>();
const tailscale=(args:readonly string[])=>{
  const ok=(stdout="")=>({status:0,stdout,stderr:""});
  if(args[0]==="status")return ok(JSON.stringify({Self:{DNSName:magic+".",UserID:42},User:{"42":{ID:42,LoginName:owner}}}));
  if(args[1]==="status")return ok(published.size?JSON.stringify({
    TCP:Object.fromEntries([...published.keys()].map(p=>[String(p),{HTTPS:true}])),
    Web:Object.fromEntries([...published].map(([p,proxy])=>[magic+":"+p,{Handlers:{"/":{Proxy:proxy}}}]))
  }):"{}");
  const match=/--https=(\d+)/.exec(args.join(" "));
  if(!match)throw Error("Unexpected scripted Tailscale command");
  const port=Number(match[1]);
  if(args.includes("off"))published.delete(port);else published.set(port,args.at(-1)!);
  return ok("https://"+magic+":"+port+"/\n");
};
const realFetch=globalThis.fetch,realNow=Date.now;
const allowedPorts=new Set<number>([sidecar.port!]);
globalThis.fetch=((input:any,init:any)=>{
  const target=new URL(typeof input==="string"||input instanceof URL?String(input):input.url);
  if(target.hostname!=="127.0.0.1"||!allowedPorts.has(Number(target.port)))throw Error("Inert proof refused non-fixture network");
  return realFetch(input,init);
}) as typeof fetch;
let server:any;
try{
  const {startInboxServer}=await import(pathToFileURL(join(process.cwd(),"packages/server/inbox.ts")).href);
  server=await startInboxServer({dataDir:data,version:"0.28.66",binaryPath:null,phones:false,port:0,tailscale,
    updates:{fetchRelease:async()=>({ok:false,error:"inert no-network proof"}),fetchReleasePage:async()=>({ok:false,error:"inert no-network proof"})}});
  const base="http://127.0.0.1:"+server.port;
  const listener=server.tailscale.listenerPort();
  check(typeof listener==="number","Scripted tailnet listener did not start");
  allowedPorts.add(server.port);allowedPorts.add(listener);
  const remote="http://127.0.0.1:"+listener;
  const headers=(login=owner)=>({Host:magic+":"+server.port,"Tailscale-User-Login":login,
    Origin:"https://"+magic+":"+server.port,"Sec-Fetch-Site":"same-origin","Content-Type":"application/json"});
  const healthPath="/api/inbox/orca",threadsPath="/api/inbox/threads";
  const imported=(value:any)=>value.projects.filter((p:any)=>p.orca_imported);
  let list:any;
  for(let i=0;i<50;i++){
    list=await(await fetch(base+threadsPath)).json();
    if(imported(list).length===1)break;
    await Bun.sleep(10);
  }
  check(imported(list).length===1,"Approved zero-message project was not imported");
  check(imported(list).every((p:any)=>p.threads===0&&p.unread===0&&p.listed===0),"Project import fabricated Inbox counts");
  const localResponse=await fetch(base+healthPath),local=await localResponse.json();
  check(localResponse.status===200&&local.mode==="orca"&&local.connected===true,"Local health regressed");
  const remoteResponse=await fetch(remote+healthPath,{headers:headers()}),remoteHealth=await remoteResponse.json();
  check(remoteResponse.status===200,"Verified owner cannot read health over tailnet");
  check(JSON.stringify(local)===JSON.stringify(remoteHealth),"Owner health differs from local aggregate projection");
  const noOrigin=headers();delete (noOrigin as any).Origin;
  check((await fetch(remote+healthPath,{headers:noOrigin})).status===200,"Owner same-origin GET without Origin was refused");
  const privateText=JSON.stringify(remoteHealth);
  for(const value of [root,key.toString("hex"),"private-native-session","private-diagnostic"])
    check(!privateText.includes(value),"Health disclosed private bridge evidence");

  check((await fetch(remote+healthPath,{headers:{...headers(),Origin:"https://proxy.example"}})).status===200,"Trusted same-origin proxy behavior changed");

  const beforeDenied=healthReads;
  check((await fetch(remote+healthPath,{headers:headers(guest)})).status===403,"Allowed guest read owner health");
  check((await fetch(remote+healthPath,{headers:{...headers(),Host:"wrong.example"}})).status===403,"Wrong served host reached health");
  const missingIdentity=headers();delete (missingIdentity as any)["Tailscale-User-Login"];
  check((await fetch(remote+healthPath,{headers:missingIdentity})).status===403,"Missing identity reached health");
  check((await fetch(remote+healthPath,{headers:headers("unallowed@example.invalid")})).status===403,"Unallowed identity reached health");
  for(const value of [
    {...headers(),Origin:"https://foreign.example","Sec-Fetch-Site":"cross-site"},
    {...headers(),"Sec-Fetch-Site":"same-site"},
    {...headers(),Origin:"null"},
    {...headers(),Origin:"https://foreign.example","Sec-Fetch-Site":"none"}
  ])check((await fetch(remote+healthPath,{headers:value})).status===403,"Cross-site owner request reached health");
  for(const method of ["HEAD","POST","PUT","DELETE"])
    check((await fetch(remote+healthPath,{method,headers:headers(),...(method==="HEAD"?{}:{body:"{}"})})).status===405,"Health accepted "+method);
  check(healthReads===beforeDenied,"Refused health request contacted private sidecar");
  check(!existsSync(join(state,"update-attempt.json")),"Health read queued an upgrade");

  // A phone-only owner session must refresh newly approved projects, without guest-triggered reads.
  projects.push({name:"Second native project",root:secondProject});
  Date.now=()=>realNow()+31000;
  const beforeRefresh=catalogReads;
  // Upstream is owner-only over Tailscale (v0.28.66): a formerly allowed login reads nothing.
  const guestList=await fetch(remote+threadsPath,{headers:headers(guest)});
  check(guestList.status===403,"A non-owner tailnet identity read the thread list");
  check(catalogReads===beforeRefresh,"Guest triggered native directory refresh");
  await fetch(base+threadsPath,{headers:{Origin:"https://foreign.example","Sec-Fetch-Site":"cross-site"}});
  check(catalogReads===beforeRefresh,"Cross-site local read triggered native directory refresh");
  for(let i=0;i<50;i++){
    list=await(await fetch(remote+threadsPath,{headers:headers()})).json();
    if(imported(list).length===2)break;
    await Bun.sleep(10);
  }
  check(imported(list).length===2,"Phone-only owner reads did not refresh approved projects");
  check(catalogReads===beforeRefresh+1,"Repeated owner reads bypassed refresh debounce");
  check(imported(list).every((p:any)=>p.threads===0&&p.unread===0&&p.listed===0),"Phone refresh fabricated Inbox activity");
  check(authorized,"Private sidecar bearer was not preserved");
  check(!existsSync(join(state,"update-attempt.json")),"Directory refresh queued an upgrade");
  check((await fetch(base+healthPath,{headers:headers()})).status===403,"Loopback accepted tailnet identity headers");

  // Exercise the actual LaunchHost and run-line consumer, rather than merely
  // checking that a null poll was emitted (upstream retains prior busy polls).
  const {createOrcaLaunchHosts}=await import(pathToFileURL(join(process.cwd(),"packages/server/inbox-orca-host.ts")).href);
  const {inboxRunOf}=await import(pathToFileURL(join(process.cwd(),"packages/core/inbox-run-line.ts")).href);
  let bridgeLive:any={busy:true,busySince:realNow()-1000,polls:2};
  const host=createOrcaLaunchHosts({dataDir:data,bridge:{runStateOf:()=>bridgeLive}})[0];
  const evidence=(hostState:any,live:any)=>({launch:{id:"launch_inert",agent:"codex",folder:project},project,now:realNow(),
    startedAt:realNow()-120000,again:false,cliAvailable:true,live,turnWaiting:false,seenLive:true,host:hostState,
    waitingSince:null,respawnFailed:null,stoppedByPersonAt:null,attachCommand:null});
  nativeSessions.native_empty={busy:true,state:"working",workspaceId:"inert-workspace"};
  let states=await host.sessions();
  check(inboxRunOf(evidence(states!("native_empty"),host.live!("native_empty")) as any)?.state==="working","Known native work lost its run line");
  for(const priorBusy of [true,false]){
    Date.now=()=>realNow()+35000+(priorBusy?0:3000);
    bridgeLive={busy:priorBusy,busySince:realNow()-1000,polls:3};
    nativeSessions.native_empty={busy:null,state:"unknown",workspaceId:"inert-workspace"};
    states=await host.sessions();const live=host.live!("native_empty");
    check(states!("native_empty")!=="absent"&&(states!("native_empty") as any).status===null,"Proven empty chat became absent or idle");
    check(live?.busy===null&&live.busySince===null,"Prior busy state survived a fresh native unknown");
    check(inboxRunOf(evidence(states!("native_empty"),live) as any)===null,"Unknown native activity displayed working or ended");
    for(const elapsed of [3000,9000]){
      Date.now=()=>realNow()+35000+(priorBusy?0:20000)+elapsed;
      const cachedLive=host.live!("native_empty");
      check(cachedLive?.busy===null&&inboxRunOf(evidence(states!("native_empty"),cachedLive) as any)===null,"Cached native unknown reverted to working before engine refresh");
    }
  }
  Date.now=()=>realNow()+80000;
  nativeSessions.native_empty={busy:true,state:"working",workspaceId:"inert-workspace"};
  bridgeLive={busy:true,busySince:realNow(),polls:4};states=await host.sessions();
  check(inboxRunOf(evidence(states!("native_empty"),host.live!("native_empty")) as any)?.state==="working","A refreshed native working snapshot stayed unknown");
  // A chat at a permission prompt (a newer plugin's catalog row): the run line says it waits on it, whether the chat
  // polls busy or not (a turn stopped at a prompt polls busy:false).
  for(const [step,polled] of [[1,false],[2,true]] as const){
    Date.now=()=>realNow()+80000+step*5000;
    bridgeLive={busy:polled,busySince:polled?realNow():null,polls:4+step};
    nativeSessions.native_empty={busy:false,state:"waiting",workspaceId:"inert-workspace",waiting:"permission"};
    states=await host.sessions();
    const row=states!("native_empty") as any,live=host.live!("native_empty");
    check(row!=="absent"&&row.status==="waiting"&&row.waitingFor==="permission","A native permission prompt did not reach the run line");
    check(live?.busy===true,"A native chat at a permission prompt read as idle");
    check(inboxRunOf(evidence(row,live) as any)?.state==="waiting_terminal","A native chat at a permission prompt did not show as waiting");
  }
  // Anything else (a question, an unknown word, an older plugin's row without it) reads exactly as before.
  for(const [step,waiting] of [[3,"question"],[4,"bogus"],[5,undefined]] as const){
    Date.now=()=>realNow()+80000+step*5000;
    bridgeLive={busy:false,busySince:null,polls:10+step};
    nativeSessions.native_empty={busy:false,state:"waiting",workspaceId:"inert-workspace",...(waiting?{waiting}:{})};
    states=await host.sessions();
    const row=states!("native_empty") as any,live=host.live!("native_empty");
    check(row!=="absent"&&row.status==="idle"&&row.waitingFor===null,"A native row without a permission prompt changed its host state");
    check(live?.busy===false,"A native row without a permission prompt changed the live state");
    check(inboxRunOf(evidence(row,live) as any)===null,"An idle native chat without a permission prompt showed a line");
  }
  bridgeLive=null;
  check(host.live!("native_empty")===null,"Native unknown invented a live bridge connection");
  console.log(JSON.stringify({ok:true,checks,localHealth:localResponse.status,ownerTailnetHealth:remoteResponse.status,
    guestHealth:403,crossSiteRefused:true,nonGetRefused:true,approvedEmptyProjects:imported(list).length,
    phoneOnlyRefresh:true,privateBearerVerified:authorized,providerOrUpgradeActions:0}));
}finally{
  Date.now=realNow;globalThis.fetch=realFetch;
  server?.stop();sidecar.stop(true);rmSync(root,{recursive:true,force:true});
}
