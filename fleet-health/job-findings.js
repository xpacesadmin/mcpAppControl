'use strict';
const {classify}=require('./health');

// Keep a bounded, account-address-free report of what THIS job observed.
// Never reconstruct old job results from the current live snapshot.
function finding(device,snapshot,baselines,now=Date.now(),note='') {
  const health=classify(device,snapshot,baselines,now);
  return {id:device.id,name:device.name,ip:device.ip,vlan:device.vlan,
    capturedAt:now,checkedAt:snapshot?.checkedAt||null,severity:health.severity,
    checks:health.checks.map(({key,severity,message,scope})=>({key,severity,message,scope})),note};
}
function pendingFinding(device,message='Not checked by this request') {
  return {id:device.id,name:device.name,ip:device.ip,vlan:device.vlan,
    capturedAt:null,checkedAt:null,severity:'unknown',checks:[{key:'scan',severity:'unknown',message}]};
}
function capture(job,device,snapshot,baselines,note='') {
  job.findings ||= {version:1,rows:[]};
  const row=finding(device,snapshot,baselines,Date.now(),note);
  const index=job.findings.rows.findIndex(r=>r.id===device.id);
  if(index<0)job.findings.rows.push(row);else job.findings.rows[index]=row;
  return row;
}
function summary(findings) {
  if(!findings?.rows)return null;
  const rows=findings.rows,counts={total:rows.length,healthy:0,warning:0,critical:0,unknown:0,gaps:0};
  for(const r of rows){counts[r.severity]++;if(r.severity!=='unknown'&&r.checks.some(c=>c.severity==='unknown'))counts.gaps++;}
  return counts;
}
module.exports={finding,pendingFinding,capture,summary};
