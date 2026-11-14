'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {bindObservation,appEvidence,reconcileStore}=require('../store-evidence');
const {createConsole}=require('../server');const {devices}=require('../inventory');
const pkg='com.spotify.music',core='com.google.android.gms',d=devices.find(x=>x.id==='61-210');
function snap(device=d){return {online:true,checkedAt:Date.now(),activeUser:'0',accounts:['a@example.invalid'],proxy:device.proxy,locale:device.locale,versions:{[pkg]:{installed:true,code:'2',version:'2.0'},[core]:{installed:true,code:'99'}}};}
function current(s,at=Date.now()){return bindObservation({status:'current',count:0,checkedAt:at,message:'No updates',pandoraPreserved:true,proxyUnchanged:true},s);}
test('Store zero automatically clears older pending rows on this device, not global baselines or core apps',()=>{
  const s=snap();s.store=current(s);const cfg={...d,updateEvidence:{[pkg]:{pending:true,at:s.store.checkedAt-1},[core]:{pending:true,at:1}}};
  const overrides=structuredClone({updateEvidence:cfg.updateEvidence});
  assert.equal(reconcileStore(cfg,s,overrides),1);assert.equal(overrides.updateEvidence[pkg].pending,false);
  assert.equal(overrides.updateEvidence[pkg].source,'Play Store automatic sync');assert.equal(overrides.updateEvidence[core].pending,true);
  assert.equal(reconcileStore(cfg,s,overrides),0);assert.equal(appEvidence(d,s)[pkg].code,'2');
});
test('failure, pending, stale or unbound observations never clear pending app flags',()=>{
  for(const change of [{status:'unknown'},{status:'pending',count:2},{updating:true},{checkedAt:1},{identity:'wrong'},{proxy:'wrong'},{count:undefined},{versions:undefined}]){
    const s=snap();s.store={...current(s),...change};const overrides={updateEvidence:{[pkg]:{pending:true,at:1}}};
    assert.equal(reconcileStore(d,s,overrides),0);assert.equal(overrides.updateEvidence[pkg].pending,true);
  }
});
test('evidence binds versions, user, accounts and newer owner observations',()=>{
  const s=snap();s.store=current(s);const cfg={...d,updateEvidence:{[pkg]:{pending:true,at:s.store.checkedAt+100}}};assert.deepEqual(appEvidence(cfg,s),{});
  for(const changed of [{activeUser:'10'},{accounts:['other@example.invalid']},{versions:{[pkg]:{installed:true,code:'3'}}}])assert.deepEqual(appEvidence(d,{...s,...changed}),{});
});
async function finish(job){for(let i=0;i<100&&['queued','running'].includes(job.status);i++)await new Promise(r=>setTimeout(r,5));assert.equal(job.status,'completed',job.message);}
test('all 40 devices have Store controls; non-pilot sign-in/scan/update jobs target their own device',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'store-rollout-test-'));const calls=[];
  const adb={snapshot:async device=>snap(device)};const maintenance={run:async(device,options)=>{calls.push({id:device.id,update:options.update});return {status:'current',count:0,checkedAt:Date.now(),message:'No updates',pandoraPreserved:true,proxyUnchanged:true};}};
  const app=createConsole({dataDir:dir,adb,maintenance});
  try{
    assert.equal(app.view().maintenance.deviceIds.length,40);
    for(const [id,action] of [['60-199','signin'],['61-209','scan'],['60-200','update']])await finish(app.enqueue({kind:'store',ids:[id],action,confirm:true}));
    assert.deepEqual(calls,[{id:'60-199',update:false},{id:'61-209',update:false},{id:'60-200',update:true}]);
    assert.equal(app.view().devices.find(x=>x.id==='60-199').appEvidence[pkg].code,'2');assert.deepEqual(app.state.baselines,{});
  }finally{app.close();fs.rmSync(dir,{recursive:true});}
});
test('passive Store completion refreshes installed versions then syncs stale pending flags',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'store-observer-test-'));let reads=0;
  const adb={snapshot:async()=>{const s=snap();s.versions[pkg].code=String(++reads);return s;},connected:async()=>new Set([d.serial]),egress:async()=>({ok:true,proxy:d.proxy,verifiedAt:Date.now()})};
  const maintenance={observe:async()=>({status:'current',count:0,checkedAt:Date.now(),message:'No updates'})};
  const app=createConsole({dataDir:dir,adb,maintenance});app.state.overrides[d.id]={updateEvidence:{[pkg]:{pending:true,at:1}}};
  try{await finish(app.enqueue({kind:'scan',ids:[d.id]}));assert.equal(reads,2);assert.equal(app.state.overrides[d.id].updateEvidence[pkg].pending,false);assert.equal(app.view().devices.find(x=>x.id===d.id).appEvidence[pkg].code,'2');}
  finally{app.close();fs.rmSync(dir,{recursive:true});}
});
