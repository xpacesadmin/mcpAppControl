'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {StoreMaintenance,screenState,target}=require('../store-maintenance');
const {parseSyncStatus,identity}=require('../google-health');
const {createConsole}=require('../server');const {classify}=require('../health');const {devices}=require('../inventory');
const d=devices.find(x=>x.id==='61-210');
function screen(...texts){return {width:1440,height:2560,lines:texts.map((text,i)=>({text,words:text.split(' ').map((text,j)=>({text,x:50+j*120,y:100+i*100,width:100,height:40}))}))};}
const pending=screen('Manage apps and device','Updates available','6 updates pending','Update all See details');
const current=screen('Manage apps and device','All apps up to date');
test('Store recognizes pending/current/auth/offline and does not mistake offline for sign-out',()=>{
  assert.equal(screenState(pending).count,6);assert.equal(screenState(current).count,0);
  assert.equal(screenState(screen('Authentication required','Sign in to your Google Account')).status,'sign_in_required');
  assert.equal(screenState(screen("You’re offline","Try again")).status,'unavailable');
  assert.equal(screenState(screen('Unrecognized loading layout')).status,'unknown');
  assert.equal(screenState(screen('No pending downloads')).status,'unknown');
  assert.equal(screenState(current).updating,false);
  assert.equal(screenState(screen('Downloads','Available updates (6)','Update all')).count,6);
});
test('tap targets exact button words not whole row; unrelated actions are not recognized',()=>{
  assert.deepEqual(target(pending,/^Update all$/i),{x:160,y:420});
  assert.equal(target(screen('Uninstall','Buy'),/^Update all$/i),null);
});
function fakeStore({frames=[pending],drift=false}={}) {
  let top='pro.pandorabox.pandora/.MainActivity',reads=0,tapped=false;const commands=[];
  const adb={shell:async(_,c)=>{commands.push(c);
    if(c.startsWith('echo __PROXY__'))return `__PROXY__\n${drift&&tapped?'wrong':d.proxy}\n__SERVICES__\npandora/service\n__PANDORA__\n123\n__BOUND__\nService[pandora]\n__TOP__\nmResumedActivity: ActivityRecord{x u0 ${top} t1}`;
    if(c.startsWith('am start -a'))top='com.android.vending/.MainActivity';
    if(c.startsWith('am start -n'))top=c.slice('am start -n '.length);
    if(c.startsWith('input tap'))tapped=true;return '';
  },screenshot:async()=>Buffer.from('image')};
  const m=new StoreMaintenance(adb,{ocr:async()=>frames[Math.min(reads++,frames.length-1)],wait:async()=>{}});
  return {m,commands,getTop:()=>top};
}
test('scan does not update, restore original app, no accessibility or proxy mutations',async()=>{
  const {m,commands,getTop}=fakeStore();const r=await m.run(d,{});
  assert.equal(r.count,6);assert.equal(r.updateRequested,false);assert.equal(r.pandoraPreserved,true);assert.equal(getTop(),'pro.pandorabox.pandora/.MainActivity');
  assert.ok(!commands.some(c=>/input tap|uiautomator|settings put|force-stop|install|kill-server/.test(c)));
});
test('Update Apps requires recognized Update all; verifies result separately',async()=>{
  const {m,commands,getTop}=fakeStore({frames:[pending,pending,current]});const r=await m.run(d,{update:true});
  assert.equal(r.updateRequested,true);assert.equal(r.status,'current');assert.equal(commands.filter(c=>c.startsWith('input tap')).length,1);
  assert.equal(getTop(),'pro.pandorabox.pandora/.MainActivity');assert.equal(r.updating,false);
});
test('downloads in progress never claimed complete; bounded observation',async()=>{
  const {m,commands,getTop}=fakeStore();const r=await m.run(d,{update:true});
  assert.equal(r.status,'pending');assert.match(r.message,/completion|rescan/i);assert.equal(commands.filter(c=>c.startsWith('input tap')).length,1);
  assert.equal(getTop(),'com.android.vending/.MainActivity');assert.match(r.restore,/left open/);
});
test('unknown, offline or sign-in prompt never pressed; changing UI rejected',async()=>{
  for(const s of [screen('Sign in'),screen('Try again'),screen('Unknown')]){const {m,commands}=fakeStore({frames:[s]});await m.run(d,{update:true});assert.ok(!commands.some(c=>c.startsWith('input tap')));}
  const {m,commands}=fakeStore({frames:[pending,current]});await assert.rejects(()=>m.run(d,{update:true}),/layout changed/);assert.ok(!commands.some(c=>c.startsWith('input tap')));
});
test('guard change stops maintenance, passive monitor never navigates',async()=>{
  const x=fakeStore({drift:true});await assert.rejects(()=>x.m.run(d,{update:true}),/guard changed/);
  const y=fakeStore();assert.equal(await y.m.observe(d),null);assert.ok(!y.commands.some(c=>/am start|input tap/.test(c)));
});
test('sync auth uses most recent outcome per authority and ignores old failures',()=>{
  const fixture=`Sync Status\nAccount test@example.invalid u0 com.google\ncom.android.contacts 1 true Total 0 OTHER SUCCESS\n Today 2026-11-12 12:00:00\n Yestr OTHER FAILURE\n 2026-11-01 12:00:00\n authentication-error\ncom.google.android.gms.reminders 1 true Total 0 OTHER FAILURE\n Today 2026-11-12 12:01:00\n io-error\n`;
  let a=parseSyncStatus(fixture,'2026-11-12T13:00:00');assert.equal(a.recentSuccessAccounts,1);assert.equal(a.recentAuthErrors,0);
  a=parseSyncStatus(fixture.replace('2026-11-01','2026-11-12').replace('12:00:00\n authentication','12:30:00\n authentication'),'2026-11-12T13:00:00');assert.equal(a.recentAuthErrors,1);
  assert.equal(parseSyncStatus(fixture,'2026-12-12T13:00:00').recentSuccessAccounts,0);
  assert.equal(parseSyncStatus(fixture,'2026-11-12T13:00:00','10').accountCount,0);
  const c=classify(d,{online:true,checkedAt:Date.now(),proxy:d.proxy,accounts:['test@example.invalid'],versions:{},drift:0,syncAuth:a});
  assert.equal(c.checks.find(x=>x.key==='google_sync').severity,'warning');assert.notEqual(c.checks.find(x=>x.key==='account_login').severity,'critical');
});
test('Store evidence invalidates on account/proxy change or expiry',()=>{
  const s={online:true,checkedAt:Date.now(),proxy:d.proxy,accounts:['test@example.invalid'],activeUser:'0',versions:{},drift:0,store:{status:'current',count:0,checkedAt:Date.now(),proxy:d.proxy,message:'Current'}};s.store.identity=identity(s);
  const check=s=>classify(d,s).checks.find(c=>c.key==='apps');assert.equal(check(s).severity,'healthy');
  assert.equal(check({...s,accounts:['different@example.invalid']}).severity,'unknown');
  assert.equal(check({...s,proxy:'wrong'}).severity,'unknown');s.store.checkedAt=1;assert.equal(check(s).severity,'unknown');
});
test('Store server scope, explicit approval, passive evidence retained, monitor preference durable',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-store-test-'));
  fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify({monitorEnabled:true}));
  const snap=()=>({online:true,checkedAt:Date.now(),locale:'en-GB',activeUser:'0',accounts:['test@example.invalid'],proxy:d.proxy,versions:{}});
  const adb={snapshot:async()=>snap(),connected:async()=>new Set([d.serial]),egress:async()=>({ok:true,proxy:d.proxy,verifiedAt:Date.now()})};
  const maintenance={run:async()=>({status:'pending',count:6,checkedAt:Date.now(),message:'6 updates',pandoraPreserved:true,proxyUnchanged:true})};
  const app=createConsole({dataDir:dir,adb,maintenance});
  try{
    for(const input of [{kind:'store',action:'update',ids:[d.id]},{kind:'store',action:'scan',ids:['61-250'],confirm:true},{kind:'store',action:'scan',ids:['61-209',d.id],confirm:true},{kind:'store',action:'delete',ids:[d.id],confirm:true}])assert.throws(()=>app.enqueue(input));
    assert.deepEqual(app.view().maintenance.deviceIds,devices.map(x=>x.id));
    const j=app.enqueue({kind:'store',action:'scan',ids:[d.id],confirm:true});
    for(let i=0;i<100&&['queued','running'].includes(j.status);i++)await new Promise(r=>setTimeout(r,5));
    assert.equal(j.status,'completed');assert.equal(app.state.snapshots[d.id].store.count,6);
    const scan=app.enqueue({kind:'scan',ids:[d.id]});for(let i=0;i<100&&['queued','running'].includes(scan.status);i++)await new Promise(r=>setTimeout(r,5));
    assert.equal(app.state.snapshots[d.id].store.count,6);
    assert.equal(app.state.monitorEnabled,true);
  }finally{app.close();fs.rmSync(dir,{recursive:true});}
});
