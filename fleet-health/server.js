'use strict';
const http=require('node:http');const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const {devices,apps}=require('./inventory');const {Adb,classify,FRESH_MS}=require('./health');const {diagnose}=require('./worker');
const {loadRouteBaselines}=require('./route-baselines');
const {createHealthMonitor}=require('./monitor');
const {StoreMaintenance}=require('./store-maintenance');
const {identity}=require('./google-health');
const {bindObservation,appEvidence,reconcileStore}=require('./store-evidence');
const {pendingFinding,capture,summary:findingsSummary}=require('./job-findings');
function createConsole({dataDir=path.join(__dirname,'data'),adb=new Adb(),maintenance=new StoreMaintenance(adb),worker=diagnose,routeBaselines={overrides:{},message:'No additional commissioning registry loaded'}}={}) {
  fs.mkdirSync(dataDir,{recursive:true});
  const file=path.join(dataDir,'state.json');let saved={};
  try{saved=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw new Error('State file unreadable; preserve it and repair before starting');}
  const state={snapshots:{},baselines:{},overrides:{},jobs:[],...saved};
  for(const job of state.jobs) if(['queued','running'].includes(job.status)){job.status='interrupted';job.message='Service restarted; not replayed automatically';job.finishedAt=Date.now();}
  const token=crypto.randomBytes(32).toString('hex');let active=null,controller=null;
  const monitor=createHealthMonitor({ids:devices.map(d=>d.id),enqueue:j=>enqueue(j,'monitor'),isBusy:()=>!!active||state.jobs.some(j=>['queued','running'].includes(j.status))});
  function persist(){fs.writeFileSync(file+'.tmp',JSON.stringify(state,null,2),{mode:0o600});fs.renameSync(file+'.tmp',file);}
  function device(id){const d=devices.find(x=>x.id===id);if(!d)throw new Error('Device is not in the commissioned 40-device inventory');return {...d,...routeBaselines.overrides[id],...state.overrides[id]};}
  function view(){return {now:Date.now(),worker:{model:'gpt-6.1-sol',reasoning:'max',mode:'diagnose-only',connection:'checked when a request is submitted'},
    collector:'Independent ADB health/maintenance. Pandora owns automations; no legacy MCP or XSAlpha agent.',
    maintenance:{deviceIds:devices.map(d=>d.id),mode:'Single-device owner-triggered Play Store maintenance; English UI required'},
    routeBaselines:routeBaselines.message,
    monitor:monitor.view(),
    security:'No firewall or DNS policy changes are available. Proxy tests do not certify the kill switch.',
    devices:devices.map(d=>{const cfg=device(d.id),snapshot=state.snapshots[d.id];return {...cfg,snapshot,appEvidence:appEvidence(cfg,snapshot),health:classify(cfg,snapshot,state.baselines)};}),apps,baselines:state.baselines,jobs:state.jobs.slice(-200).reverse().map(({findings,...job})=>({...job,findingsSummary:findingsSummary(findings),hasFindings:!!findings}))};}
  function audit(entry){fs.appendFileSync(path.join(dataDir,'audit.jsonl'),JSON.stringify({at:Date.now(),...entry})+'\n',{mode:0o600});}
  function syncStore(d,snapshot) {
    state.overrides[d.id] ||= {};
    const count=reconcileStore(device(d.id),snapshot,state.overrides[d.id]);
    if(count)audit({action:'store_evidence_sync',deviceId:d.id,appCount:count,observedAt:snapshot.store.checkedAt});
    return count;
  }
  async function scanOne(d,connected,deep,signal){
    if(!connected.has(d.serial)) {state.snapshots[d.id]={online:false,checkedAt:Date.now()};return;}
    try {let snap=await adb.snapshot(d,signal);const previous=state.snapshots[d.id];
      const old=previous?.egress;
      const fresh=old?.ok && Number.isFinite(old.verifiedAt) && Date.now()-old.verifiedAt<FRESH_MS && old.proxy===d.proxy && previous.proxy===d.proxy && snap.proxy===d.proxy;
      // Sync refreshes missing/stale egress once. Deep scan forces one probe.
      // A misconfigured device is reported, not silently tested on a different path.
      if(snap.proxy!==d.proxy)snap.egress={ok:false,proxy:snap.proxy,indeterminate:true,verifiedAt:Date.now(),message:'Configured proxy differs from assignment; no probe was sent'};
      else snap.egress=deep||!fresh?await adb.egress(d,signal):old;
      if(previous?.store&&previous.store.identity===identity(snap)&&previous.store.proxy===snap.proxy)snap.store=previous.store;
      if(/^en[-_]/i.test(snap.locale||'')&&maintenance.observe) {
        try{const observed=await maintenance.observe(d,signal);if(observed){
          // Read versions AFTER completion, not from before a package finished.
          if(observed.status==='current'){
            const after=await adb.snapshot(d,signal);
            if(identity(after)!==identity(snap)||after.proxy!==snap.proxy)throw new Error('Inventory changed during Store observation');
            after.egress=snap.egress;snap=after;
          }
          snap.store=bindObservation(observed,snap);
        }}
        catch(e){if(signal.aborted)throw e;snap.storeObservation='Visible Store check unavailable; retained previous evidence, if any';}
      }
      state.snapshots[d.id]=snap;syncStore(d,snap);}
    catch(e){if(signal.aborted)throw e;state.snapshots[d.id]={online:true,collectorError:'Device responded to ADB inventory but health collection failed',checkedAt:Date.now()};}
  }
  async function run(job,signal){
    const list=job.ids.map(device);
    if(job.kind==='scan') {
      let connected;
      try{connected=await adb.connected(signal);}catch(e){for(const d of list){state.snapshots[d.id]={collectorError:'ADB collector unavailable — physical device status unknown',checkedAt:Date.now()};capture(job,d,state.snapshots[d.id],state.baselines);}throw new Error('ADB collector unavailable — device status not inferred');}
      // Bounded concurrency, one attempt/device, no recursive scans or background loops.
      let index=0;
      await Promise.all(Array.from({length:Math.min(3,list.length)},async()=>{while(index<list.length){if(signal.aborted)throw new Error('Cancelled');const d=list[index++];await scanOne(d,connected,job.deep,signal);capture(job,device(d.id),state.snapshots[d.id],state.baselines);job.done++;job.message=`Checked ${job.done}/${list.length}`;persist();}}));
    } else if(job.kind==='repair') {
      for(const d of list){if(signal.aborted)throw new Error('Cancelled');
        const before=state.snapshots[d.id];
        audit({jobId:job.id,action:job.action,deviceId:d.id,phase:'before',proxy:before?.proxy,timezone:before?.timezone,epoch:before?.epoch});
        const result=await adb.repair(d,job.action,before,signal,job.pkg);
        if(result.snapshot){result.snapshot.egress ||= before?.egress;state.snapshots[d.id]=result.snapshot;}
        if(result.snapshot)capture(job,device(d.id),result.snapshot,state.baselines,result.message);
        else job.findings.rows[job.ids.indexOf(d.id)]={...pendingFinding(d,'No health rescan was performed by this action'),note:result.message};
        job.message=result.message;job.done++;audit({jobId:job.id,deviceId:d.id,phase:'verified',action:job.action});persist();
      }
    } else if(job.kind==='store') {
      const d=list[0];
      audit({jobId:job.id,kind:'store',action:job.action,deviceId:d.id,phase:'before'});
      const before=await adb.snapshot(d,signal);
      if(!/^en[-_]/i.test(before.locale||''))throw new Error('Store screen scan currently supports English only; locale was not changed.');
      const result=await maintenance.run(d,{update:job.action==='update',signal,onProgress:m=>{job.message=m;persist();}});
      const after=await adb.snapshot(d,signal);
      if(identity(before)!==identity(after))throw new Error('Android user/account inventory changed during maintenance. Result not accepted.');
      after.egress=state.snapshots[d.id]?.egress;
      after.store=bindObservation(result,after);state.snapshots[d.id]=after;
      const synced=syncStore(d,after);
      job.message=result.message+(synced?` ${synced} app status(es) synchronized automatically.`:'');job.done=1;
      capture(job,device(d.id),after,state.baselines,job.message);
      audit({jobId:job.id,kind:'store',deviceId:d.id,status:result.status,updateRequested:result.updateRequested,pandoraPreserved:result.pandoraPreserved,proxyUnchanged:result.proxyUnchanged});
    } else if(job.kind==='ai') {
      for(const d of list)capture(job,d,state.snapshots[d.id],state.baselines,'Evidence supplied to AI; this request does not run a new device scan.');
      const evidence=list.map(d=>{const s=state.snapshots[d.id];return {id:d.id,assignedProxy:d.proxy,timezone:d.timezone,health:classify(d,s,state.baselines),snapshot:s?{...s,accounts:s.accounts===null?null:{count:s.accounts?.length},versions:s.versions}:null};});
      job.message='Starting separate local Codex worker';
      job.result=await worker({request:job.note,devices:evidence,guardrail:'Never weaken DNS/WAN kill switch'}, {signal,onProgress:m=>{job.message=m;persist();}});job.done=list.length;
    }
  }
  async function drain(){if(active)return;const job=state.jobs.find(j=>j.status==='queued');if(!job)return;
    active=job;controller=new AbortController();job.status='running';job.startedAt=Date.now();persist();
    const deadline=job.source==='monitor'?setTimeout(()=>controller?.abort(),90000):job.kind==='store'?setTimeout(()=>controller?.abort(),180000):null;
    try{await run(job,controller.signal);job.status=controller.signal.aborted?'cancelled':'completed';}
    catch(e){job.status=controller.signal.aborted?'cancelled':'failed';job.message=e.message;}
    finally{if(deadline)clearTimeout(deadline);job.finishedAt=Date.now();audit({jobId:job.id,kind:job.kind,status:job.status});active=null;controller=null;persist();setImmediate(drain);}
  }
  function enqueue(input,source='owner'){
    if(!['scan','repair','ai','store'].includes(input.kind))throw new Error('Invalid job kind');
    const ids=[...new Set(input.ids||[])];if(!ids.length||ids.length>40)throw new Error('Select 1–40 devices');ids.forEach(device);
    if(state.jobs.filter(j=>['queued','running'].includes(j.status)).length>=6)throw new Error('Queue full');
    if(input.kind==='repair' && (!['clock','proxy','accounts','store'].includes(input.action)||input.confirm!==true))throw new Error('Repair requires an allowed action and explicit confirmation');
    if(input.kind==='repair'&&['accounts','store'].includes(input.action)&&ids.length!==1)throw new Error('Interactive settings are opened on one device at a time');
    if(input.kind==='ai'&&input.confirm!==true)throw new Error('Confirm submission to the separate AI worker');
    if(input.kind==='repair'&&input.action==='store'&&!apps.some(a=>a.pkg===input.pkg))throw new Error('Package is not allowlisted');
    if(input.kind==='store'&&(input.confirm!==true||ids.length!==1||!['signin','scan','update'].includes(input.action)))throw new Error('Store maintenance requires explicit confirmation and one commissioned device; choose signin, scan or update');
    const previous=state.jobs.filter(j=>j.kind===input.kind&&j.status==='completed'&&j.startedAt&&j.finishedAt).slice(-5);
    const perDevice=previous.length?previous.reduce((s,j)=>s+(j.finishedAt-j.startedAt)/j.ids.length,0)/previous.length:null;
    const job={id:crypto.randomUUID(),kind:input.kind,ids,source,action:input.action,pkg:input.pkg,deep:input.deep===true,note:String(input.note||'').slice(0,2000),status:'queued',done:0,createdAt:Date.now(),estimateMs:perDevice?Math.round(perDevice*ids.length):null,message:'Waiting in local queue'};
    job.findings={version:1,rows:ids.map(id=>pendingFinding(device(id)))};
    state.jobs.push(job);if(state.jobs.length>200)state.jobs.splice(0,state.jobs.length-200);persist();setImmediate(drain);return job;
  }
  const server=http.createServer(async(req,res)=>{
    const address=server.address();const origin=`http://127.0.0.1:${address.port}`;
    const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
    if(req.headers.host!==`127.0.0.1:${address.port}`)return send(403,{error:'Invalid host'});
    if(req.headers.origin&&req.headers.origin!==origin)return send(403,{error:'Cross-origin request refused'});
    const url=new URL(req.url,origin);
    if(url.pathname.startsWith('/api/')){
      if(req.headers['x-fleet-token']!==token)return send(401,{error:'Open the console with Start-Fleet-Health.ps1'});
      try{
        if(req.method==='GET'&&url.pathname==='/api/state')return send(200,view());
        if(req.method==='GET'&&url.pathname==='/api/job-results'){
          const job=state.jobs.find(j=>j.id===url.searchParams.get('id'));
          return job?send(200,{findings:job.findings||null}):send(404,{error:'Request not found'});
        }
        let body='';for await(const chunk of req){body+=chunk;if(body.length>32000)return send(413,{error:'Request too large'});}const input=body?JSON.parse(body):{};
        if(req.method==='POST'&&url.pathname==='/api/jobs')return send(202,enqueue(input));
        if(req.method==='POST'&&url.pathname==='/api/monitor'){
          if(typeof input.enabled!=='boolean')throw new Error('Specify enabled true or false');
          state.monitorEnabled=input.enabled;monitor.setEnabled(input.enabled);persist();
          audit({action:'health_monitor',enabled:input.enabled,intervalSeconds:60});return send(200,monitor.view());
        }
        if(req.method==='POST'&&url.pathname==='/api/cancel') {const job=state.jobs.find(j=>j.id===input.id);if(!job||!['queued','running'].includes(job.status))throw new Error('Job not cancellable');if(active?.id===job.id){controller.abort();job.message='Cancellation requested';}else{job.status='cancelled';job.finishedAt=Date.now();}persist();return send(200,{ok:true});}
        if(req.method==='POST'&&url.pathname==='/api/baseline') {
          const d=device(input.id),s=state.snapshots[d.id];if(input.confirm!==true||!s?.online||Date.now()-s.checkedAt>600000)throw new Error('Fresh scan and explicit Play Store confirmation required');
          const v=s.versions[input.pkg];if(!s.variant||!v?.code)throw new Error('Installed app version unavailable');
          state.baselines[`${s.variant}|${input.pkg}`]={...v,confirmedAt:Date.now(),sourceDevice:d.id};persist();return send(200,{ok:true});
        }
        if(req.method==='POST'&&url.pathname==='/api/update-evidence'){
          const d=device(input.id);if(input.confirm!==true||!apps.some(a=>a.pkg===input.pkg))throw new Error('App confirmation required');
          state.overrides[d.id] ||= {};state.overrides[d.id].updateEvidence ||= {};
          state.overrides[d.id].updateEvidence[input.pkg]={pending:input.pending===true,at:Date.now(),source:'owner Play Store observation'};persist();return send(200,{ok:true});
        }
        return send(404,{error:'Not found'});
      }catch(e){return send(400,{error:e.message});}
    }
    const staticFiles={'/':'index.html','/app.js':'app.js','/ui-model.js':'ui-model.js','/style.css':'style.css'};
    if(req.method!=='GET'||!staticFiles[url.pathname])return send(404,{error:'Not found'});
    res.writeHead(200,{'Content-Type':url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.css')?'text/css':'text/html','Cache-Control':'no-store','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"});res.end(fs.readFileSync(path.join(__dirname,'public',staticFiles[url.pathname])));
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  server.once('listening',()=>{if(state.monitorEnabled===true)monitor.setEnabled(true);});
  server.once('close',()=>monitor.stop());
  return {server,state,token,enqueue,view,close:()=>{monitor.stop();controller?.abort();server.close();}};
}
if(require.main===module){const app=createConsole({routeBaselines:loadRouteBaselines(devices)});const port=Number(process.env.FLEET_HEALTH_PORT||8790);app.server.listen(port,'127.0.0.1',()=>{
  fs.writeFileSync(path.join(__dirname,'data','launch.json'),JSON.stringify({url:`http://127.0.0.1:${port}/#${app.token}`,pid:process.pid}),{mode:0o600});
  console.log(`XSAlpha Fleet Health listening on 127.0.0.1:${port}. Use Start-Fleet-Health.ps1 to open.`);
});app.server.on('error',e=>{console.error(e.code);process.exitCode=1;});}
module.exports={createConsole};
