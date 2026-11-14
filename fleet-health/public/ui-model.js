'use strict';
(function(root){
  const tabs=['overview','servers','activity'];
  function tab(value){return /^box6[01]$/.test(value)?'servers':tabs.includes(value)?value:'overview';}
  function timestamp(value) {
    if(!Number.isFinite(value)||value<=0)return '—';
    return new Intl.DateTimeFormat(undefined,{year:'numeric',month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',timeZoneName:'short'}).format(new Date(value));
  }
  function timestamps(job){return [{label:'Requested',value:job.createdAt},{label:'Started',value:job.startedAt},{label:'Finished',value:job.finishedAt}];}
  function filterJobs(jobs,filter){return jobs.filter(j=>filter==='all'||(filter==='health'?j.kind==='scan':j.kind!=='scan'));}
  function alarms(health){return (health?.checks||[]).filter(c=>['critical','warning'].includes(c.severity)).sort((a,b)=>(a.severity==='critical'?0:1)-(b.severity==='critical'?0:1));}
  function briefCheck(c){
    if(c.key==='google_sync')return 'Google sync authentication needs review';
    if(c.key==='apps'&&c.severity==='unknown')return 'Play Store updates not yet verified';
    if(c.key==='account_login'&&c.severity==='unknown')return 'Google sign-in status not yet verified';
    if(c.key==='connection'&&c.severity==='critical')return 'ADB unreachable';
    const message=c.message.split('. Checked ')[0];return message.length>140?message.slice(0,137)+'…':message;
  }
  function brief(health){const rows=alarms(health);if(rows.length)return rows.slice(0,2).map(briefCheck).join(' · ')+(rows.length>2?` · +${rows.length-2} more`: '');const gaps=(health?.checks||[]).filter(c=>c.severity==='unknown');return gaps.length?briefCheck(gaps[0]):'All recorded checks passed';}
  function findingsSummary(findings){
    if(findings?.total!=null){const s=findings;return `${s.total} fleets · ${s.healthy} operationally healthy · ${s.warning} warning · ${s.critical} critical · ${s.unknown} unverified${s.gaps?` · ${s.gaps} with additional verification gaps`:''}`;}
    if(!findings?.rows)return 'Detailed findings were not saved for this older request.';
    const rows=findings.rows,critical=rows.filter(r=>r.severity==='critical').length,
      warning=rows.filter(r=>r.severity==='warning').length,
      unknown=rows.filter(r=>r.severity==='unknown').length,
      passed=rows.filter(r=>r.severity==='healthy').length,
      gaps=rows.filter(r=>r.severity!=='unknown'&&r.checks.some(c=>c.severity==='unknown')).length;
    return `${rows.length} fleets · ${passed} operationally healthy · ${warning} warning · ${critical} critical · ${unknown} unverified${gaps?` · ${gaps} with additional verification gaps`:''}`;
  }
  const api={tabs,tab,timestamp,timestamps,filterJobs,alarms,brief,findingsSummary};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.FleetUI=api;
})(globalThis);
