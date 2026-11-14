'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {once}=require('node:events');
const {createConsole}=require('../server');const {devices}=require('../inventory');
const {finding,pendingFinding,summary}=require('../job-findings');
const ui=require('../public/ui-model');
const d=devices[0];
async function finish(j){for(let n=0;n<100&&['queued','running'].includes(j.status);n++)await new Promise(r=>setTimeout(r,5));return j;}
function harness(adb){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-findings-'));const app=createConsole({dataDir:dir,adb,maintenance:{}});return {app,close:()=>{app.close();fs.rmSync(dir,{recursive:true});}};}

test('findings capture immutable observations without account identifiers or raw snapshots',()=>{
  const snapshot={online:false,checkedAt:Date.now(),accounts:['private@example.invalid']};
  const r=finding(d,snapshot,{});snapshot.online=true;
  assert.equal(r.severity,'critical');assert.match(r.checks[0].message,/unreachable/);
  assert.doesNotMatch(JSON.stringify(r),/private@example|accounts|versions/);
  assert.equal(pendingFinding(d).severity,'unknown');
});
test('all 40 target rows are retained, including offline devices; later scans do not rewrite history',async()=>{
  const h=harness({connected:async()=>new Set()});
  try{
    const job=await finish(h.app.enqueue({kind:'scan',ids:devices.map(x=>x.id)}));
    assert.equal(job.status,'completed');assert.equal(job.findings.rows.length,40);assert.equal(summary(job.findings).critical,40);
    const saved=JSON.stringify(job.findings);h.app.state.snapshots[d.id]={online:true,checkedAt:Date.now()};
    await finish(h.app.enqueue({kind:'scan',ids:[d.id]}));assert.equal(JSON.stringify(job.findings),saved);
    const view=h.app.view().jobs.find(j=>j.id===job.id);assert.equal(view.findings,undefined);assert.equal(view.hasFindings,true);assert.equal(view.findingsSummary.total,40);
  }finally{h.close();}
});
test('collector failures are unverified results, not inferred offline or healthy',async()=>{
  const h=harness({connected:async()=>{throw Error('private failure');}});
  try{const j=await finish(h.app.enqueue({kind:'scan',ids:[d.id]}));assert.equal(j.status,'failed');assert.equal(j.findings.rows[0].severity,'unknown');assert.match(j.findings.rows[0].checks[0].message,/collector unavailable/);assert.doesNotMatch(JSON.stringify(j.findings),/private failure/);}
  finally{h.close();}
});
test('reports are authenticated and loaded on demand; old jobs are not backfilled',async()=>{
  const h=harness({connected:async()=>new Set()});
  try{
    const j=await finish(h.app.enqueue({kind:'scan',ids:[d.id]}));
    h.app.state.jobs.push({id:'old-job',kind:'scan',ids:[d.id],status:'completed',done:1,createdAt:1});
    h.app.server.listen(0,'127.0.0.1');await once(h.app.server,'listening');
    const base='http://127.0.0.1:'+h.app.server.address().port;
    assert.equal((await fetch(base+'/api/job-results?id='+j.id)).status,401);
    const headers={'x-fleet-token':h.app.token};
    const report=await (await fetch(base+'/api/job-results?id='+j.id,{headers})).json();assert.equal(report.findings.rows[0].id,d.id);
    const old=await (await fetch(base+'/api/job-results?id=old-job',{headers})).json();assert.equal(old.findings,null);
    assert.equal((await fetch(base+'/api/job-results?id=missing',{headers})).status,404);
  }finally{h.close();}
});
test('three navigation sections, visible manual controls, and concise truthful alarm summaries',()=>{
  assert.deepEqual(ui.tabs,['overview','servers','activity']);assert.equal(ui.tab('box61'),'servers');
  const health={checks:[{severity:'warning',message:'1 app update pending'},{severity:'critical',message:'Clock offset 50s'},{severity:'healthy',message:'Proxy okay'}]};
  assert.equal(ui.brief(health),'Clock offset 50s · 1 app update pending');
  assert.equal(ui.brief({checks:[{severity:'unknown',message:'Login unverified'}]}),'Login unverified');
  assert.match(ui.findingsSummary(null),/not saved/);
  const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
  assert.doesNotMatch(source,/<details class="manual-evidence"/);
  assert.match(source,/aria-label="Manual confirmations"/);assert.match(source,/aria-label="Local AI options"/);
  assert.match(source,/expandedJobs\.has/);assert.match(source,/\/api\/job-results/);
});
