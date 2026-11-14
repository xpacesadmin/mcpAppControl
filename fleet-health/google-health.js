'use strict';
const {createHash}=require('node:crypto');
function identity(snapshot) {
  return createHash('sha256').update(JSON.stringify([snapshot.activeUser,[...(snapshot.accounts||[])].sort()])).digest('hex');
}
// Android's Sync Status table only, never token caches or notification contents.
// Its timestamps and deviceLocal are both device-local wall time (DST neutral).
function parseSyncStatus(text,deviceLocal,activeUser=null) {
  const now=Date.parse(`${deviceLocal}Z`), result={readable:/Sync Status/.test(text),recentSuccessAccounts:0,recentAuthErrors:0,authErrorServices:[],historicalAuthErrors:0,accountCount:0};
  const groups=String(text).split(/^Account /m).slice(1);
  for(const group of groups) {
    if(!/^.* u\d+ com\.google\s*$/m.test(group.split('\n')[0]))continue;
    if(activeUser!==null&&!group.split('\n')[0].endsWith(` u${activeUser} com.google`))continue;
    result.accountCount++;
    let verified=false;
    for(const block of group.split(/^(?=[a-z][a-z0-9_.-]*\s+-?\d+\s+(?:true|false)\s+Total)/m)) {
      if(!/^[a-z][a-z0-9_.-]*\s+-?\d+\s+(?:true|false)\s+Total/.test(block))continue;
      const events=[...block.matchAll(/\b(SUCCESS|FAILURE)\s*\n[^\n]*?(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?:[^\n]*\n\s*([a-z-]+))?/g)]
        .map(m=>({kind:m[1],at:Date.parse(m[2].replace(' ','T')+'Z'),error:m[3]})).sort((a,b)=>b.at-a.at);
      const last=events[0];
      if(!last)continue;
      const recent=Number.isFinite(now)&&now-last.at>=-60&&now-last.at<86400000;
      if(last.kind==='FAILURE'&&last.error==='authentication-error') {
        if(recent){result.recentAuthErrors++;result.authErrorServices.push(block.match(/^[a-z][a-z0-9_.-]*/)[0]);}else result.historicalAuthErrors++;
      } else if(last.kind==='SUCCESS'&&recent)verified=true;
    }
    if(verified)result.recentSuccessAccounts++;
  }
  result.authErrorServices=[...new Set(result.authErrorServices)];return result;
}
module.exports={parseSyncStatus,identity};
