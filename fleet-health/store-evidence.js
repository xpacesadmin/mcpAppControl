'use strict';
const {identity}=require('./google-health');
const {apps}=require('./inventory');
const STORE_TTL=24*3600000;
function freshStore(snapshot,now=Date.now()) {
  const s=snapshot?.store;
  return !!s&&Number.isFinite(s.checkedAt)&&now>=s.checkedAt&&now-s.checkedAt<STORE_TTL&&s.identity===identity(snapshot)&&s.proxy===snapshot.proxy;
}
function bindObservation(observation,snapshot) {
  return {...observation,identity:identity(snapshot),proxy:snapshot.proxy,
    versions:Object.fromEntries(Object.entries(snapshot.versions||{}).filter(([,v])=>v.installed===true&&v.code).map(([pkg,v])=>[pkg,String(v.code)]))};
}
function appEvidence(device,snapshot,now=Date.now()) {
  if(!snapshot)return {};
  const s=snapshot.store,out={};
  // This is device-local Store availability, never a global version baseline.
  if(!freshStore(snapshot,now)||s.status!=='current'||s.count!==0||s.updating)return out;
  for(const app of apps) {
    const v=snapshot.versions?.[app.pkg],owner=device.updateEvidence?.[app.pkg];
    if(app.core||!v?.code||v.installed!==true||s.versions?.[app.pkg]!==String(v.code)||owner?.at>s.checkedAt)continue;
    out[app.pkg]={pending:false,at:s.checkedAt,code:String(v.code),source:'Play Store automatic sync',
      message:'No update offered by Play Store',identity:s.identity,proxy:s.proxy};
  }
  return out;
}
function reconcileStore(device,snapshot,overrides,now=Date.now()) {
  const evidence=appEvidence(device,snapshot,now);let changed=0;
  for(const [pkg,value] of Object.entries(evidence)) {
    const old=overrides.updateEvidence?.[pkg];
    if(old?.source===value.source&&old.at===value.at&&old.code===value.code)continue;
    overrides.updateEvidence ||= {};overrides.updateEvidence[pkg]=value;changed++;
  }
  return changed;
}
module.exports={freshStore,bindObservation,appEvidence,reconcileStore,STORE_TTL};
