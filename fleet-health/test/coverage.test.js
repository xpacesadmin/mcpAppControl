'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {devices,apps}=require('../inventory');const {classify,parseSnapshot,Adb}=require('../health');const {createConsole}=require('../server');const {loadRouteBaselines}=require('../route-baselines');
const d=devices.find(x=>x.id==='61-210');
function snap(){return {online:true,checkedAt:Date.now(),drift:0,proxy:d.proxy,timezone:d.timezone,locale:d.locale,accounts:['test@example.invalid'],versions:Object.fromEntries(apps.filter(a=>a.core).map(a=>[a.pkg,{installed:true,enabled:true,suspended:false,hidden:false}])),egress:{ok:true,proxy:d.proxy,ip:d.expectedExit,verifiedAt:Date.now()},temperature:30};}

test('unknown updates and login are visible coverage gaps, never falsely passed',()=>{
  const s=snap();s.versions.pkg={code:'2'};const c=classify(d,s);
  assert.equal(c.severity,'healthy');assert.equal(c.coverageComplete,false);
  for(const key of ['apps','account_login']){const check=c.checks.find(c=>c.key===key);assert.equal(check.severity,'unknown');assert.equal(check.scope,'coverage');}
  assert.equal(classify({...d,updateEvidence:{pkg:{pending:true,at:Date.now()}}},s).severity,'warning');
});
test('Google component failures critical, missing evidence gray, disabled optional Google app orange',()=>{
  for(const patch of [{installed:false},{enabled:false},{suspended:true},{hidden:true}]){const s=snap();Object.assign(s.versions['com.google.android.gms'],patch);assert.equal(classify(d,s).checks.find(c=>c.key==='google_apps').severity,'critical');}
  assert.equal(classify(d,{...snap(),versions:{}}).severity,'unknown');
  const s=snap();s.versions['com.google.android.gm']={installed:true,enabled:false};assert.equal(classify(d,s).severity,'warning');
});
test('package parser uses active user and active package, not factory backup',()=>{
  const raw=`__USER__\n10\n__PACKAGES_ENABLED__\npackage:com.google.android.gms\nENABLED_RC=0\n__PACKAGES_DISABLED__\npackage:com.android.vending\nDISABLED_RC=0\n__APPS__\nPACKAGE=com.google.android.gms\nversionCode=100\nversionName=current\n User 0: installed=false hidden=true suspended=true\n User 10: installed=true hidden=false suspended=false\nversionCode=1\nversionName=factory\n User 10: installed=true hidden=true suspended=true\nPACKAGE=com.android.vending\nversionCode=50\n User 10: installed=true hidden=false suspended=false\n__END__\n`;
  const s=parseSnapshot(raw);assert.equal(s.activeUser,'10');assert.equal(s.versions['com.google.android.gms'].code,'100');assert.equal(s.versions['com.google.android.gms'].suspended,false);assert.equal(s.versions['com.google.android.gms'].enabled,true);assert.equal(s.versions['com.android.vending'].enabled,false);assert.equal(s.versions['com.spotify.music'].installed,false);
  assert.equal(parseSnapshot(raw.replace('ENABLED_RC=0','ENABLED_RC=1')).versions['com.google.android.gms'].installed,null);
});
test('egress success separate from identity, must belong to configured route',()=>{
  const s=snap(),c=classify({...d,expectedExit:null},s);
  assert.equal(c.checks.find(c=>c.key==='egress').severity,'healthy');assert.equal(c.checks.find(c=>c.key==='exit_identity').severity,'unknown');assert.equal(c.severity,'unknown');
  assert.equal(classify(d,{...s,egress:{...s.egress,proxy:'192.168.52.10:8301'}}).checks.find(c=>c.key==='egress').severity,'unknown');
});
test('probe-service failure unknown; connection failure critical; no direct retry',async()=>{
  const a=new Adb('fake');let calls=0;a.shell=async()=>{calls++;throw Object.assign(Error(),{code:22});};
  const failed=await a.egress(d);assert.equal(failed.indeterminate,true);assert.equal(calls,1);assert.equal(classify(d,{...snap(),egress:failed}).checks.find(c=>c.key==='egress').severity,'unknown');
  a.shell=async()=>{calls++;throw Object.assign(Error(),{code:7});};assert.equal((await a.egress(d)).indeterminate,false);assert.equal(calls,2);
});
test('route registry read-only and endpoint-keyed; cannot overwrite UK assignment',()=>{
  const {DatabaseSync}=require('node:sqlite');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'route-baseline-test-')),file=path.join(dir,'registry.sqlite');
  const db=new DatabaseSync(file);db.exec('CREATE TABLE proxy_routes(internal_host,internal_port,expected_public_ip,country,city,health_state)');const insert=db.prepare('INSERT INTO proxy_routes VALUES(?,?,?,?,?,?)');
  insert.run('192.168.52.10',8202,'203.0.113.2','US','Orem','verified');insert.run('192.168.52.10',8303,'203.0.113.3','US','Orem','verified');insert.run('192.168.52.10',8201,'not-an-ip','US','Orem','verified');db.close();
  try{const before=fs.readFileSync(file),r=loadRouteBaselines(devices,file);assert.equal(r.overrides['60-199'].expectedExit,'203.0.113.2');assert.equal(r.overrides['60-199'].timezone,'America/Denver');assert.equal(r.overrides['61-210'],undefined);assert.equal(r.overrides['60-167'],undefined);assert.deepEqual(fs.readFileSync(file),before);assert.deepEqual(loadRouteBaselines(devices,path.join(dir,'absent')).overrides,{});}finally{fs.rmSync(dir,{recursive:true});}
});
test('normal sync probes stale/missing once, reuses fresh, never probes wrong assignment',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-scan-test-'));let probes=0,current=snap();
  const adb={connected:async()=>new Set([d.serial]),snapshot:async()=>({...current,checkedAt:Date.now()}),egress:async()=>{probes++;return {...snap().egress};}};const app=createConsole({dataDir:dir,adb});
  async function scan(deep=false){const j=app.enqueue({kind:'scan',ids:[d.id],deep});for(let i=0;i<100&&['queued','running'].includes(j.status);i++)await new Promise(r=>setTimeout(r,5));assert.equal(j.status,'completed');}
  try{await scan();assert.equal(probes,1);await scan();assert.equal(probes,1);app.state.snapshots[d.id].egress.verifiedAt=1;await scan();assert.equal(probes,2);await scan(true);assert.equal(probes,3);current={...snap(),proxy:'192.168.52.10:8301'};await scan(true);assert.equal(probes,3);assert.equal(app.state.snapshots[d.id].egress.ok,false);}finally{app.close();fs.rmSync(dir,{recursive:true});}
});
