'use strict';
const $=s=>document.querySelector(s);let state=null,selected=sessionStorage.getItem('fleet-device'),pendingConfirm=null;
const expandedJobs=new Set(),resultCache=new Map();let manualPackage='',aiNote='Diagnose the current health deficiencies and propose the safest next action.';
let activeTab=FleetUI.tab(sessionStorage.getItem('fleet-tab')),detailTab=sessionStorage.getItem('fleet-detail-tab')==='apps'?'apps':'health';
const hash=location.hash.slice(1);if(/^[a-f0-9]{64}$/.test(hash)){sessionStorage.setItem('fleet-token',hash);history.replaceState(null,'',location.pathname);}
const token=sessionStorage.getItem('fleet-token');const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function toast(s){$('#toast').textContent=s;$('#toast').classList.add('show');setTimeout(()=>$('#toast').classList.remove('show'),6000);}
async function api(url,body){const res=await fetch(url,{method:body?'POST':'GET',headers:{'x-fleet-token':token||'','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const result=await res.json();if(!res.ok)throw Error(result.error);return result;}
function confirmAction(title,text,fn){$('#confirm-title').textContent=title;$('#confirm-text').textContent=text;pendingConfirm=fn;$('#confirm').showModal();}
$('#confirm-no').onclick=()=>$('#confirm').close();$('#confirm-yes').onclick=async()=>{$('#confirm').close();try{await pendingConfirm?.();await refresh();}catch(e){toast(e.message);}};
async function submit(job){await api('/api/jobs',job);toast('Request queued. Track it in Activity.');await refresh();}
function elapsed(ms){return `${Math.floor(ms/60000)}m ${Math.floor(ms/1000)%60}s`;}
function severity(ds){return ['critical','warning','unknown','healthy'].find(s=>ds.some(d=>d.health.severity===s))||'unknown';}
function gaps(d){return d.health.checks.filter(c=>c.severity==='unknown').length;}
function render(){
  const ds=state.devices,online=ds.filter(d=>d.snapshot?.online).length;
  const scrolls=[...document.querySelectorAll('.device-list')].map(e=>e.scrollTop);
  $('#summary').innerHTML=[['ADB reachable',`${online} / 40`,'Last collected inventory'],['Critical',ds.filter(d=>d.health.severity==='critical').length,'Requires your attention'],['Warnings',ds.filter(d=>d.health.checks.some(c=>c.severity==='warning')).length,'Updates or minor deficiencies'],['Operationally healthy',ds.filter(d=>d.health.severity==='healthy').length,`${ds.filter(d=>gaps(d)).length} devices have verification gaps`]].map(([label,n,sub])=>`<div class="stat"><div class="label">${label}</div><strong>${n}</strong><small>${sub}</small></div>`).join('');
  $('#route-baselines').textContent=state.routeBaselines||'';
  const mon=state.monitor||{};
  $('#auto-health').textContent=`Automatic health: ${mon.enabled?'ON · every 60s':'OFF'}`;
  $('#auto-health-status').textContent=mon.enabled?`Read-only · ${mon.deviceCount} devices · next opportunity ${mon.nextAt?new Date(mon.nextAt).toLocaleTimeString():'pending'} · busy cycles skipped: ${mon.skipped}. No app launches or updates. Reads Store screens already open on any fleet.`:'Background checks paused.';
  for(const [i,v] of [60,61].entries())$('#box'+v).innerHTML=renderBox(v,i);
  $('#box-shortcuts').innerHTML=[60,61].map((v,i)=>{const list=ds.filter(d=>d.vlan===v);return `<button class="box-shortcut ${severity(list)}" data-tab="servers" data-box="${v}"><span><strong>BOX–PROXY ${i+1}</strong><small>VLAN ${v} · 20 commissioned devices</small></span><span>${list.filter(d=>d.snapshot?.online).length}/20 reachable &nbsp; →</span></button>`;}).join('');
  document.querySelectorAll('.box .count').forEach((element,index)=>{const count=ds.filter(d=>d.vlan===[60,61][index]&&d.snapshot?.online).length;element.innerHTML=`${count}<small> / 20 ADB connected</small>`;});
  document.querySelectorAll('.device-list').forEach((element,index)=>element.scrollTop=scrolls[index]||0);
  renderDetail();
  renderJobs();
}
function renderDetail(){
  const panel=$('#details'),d=state.devices.find(d=>d.id===selected);
  panel.hidden=!d;if(!d){panel.innerHTML='';return;}
  // Do not replace an input while the operator is typing or selecting.
  if(document.activeElement?.closest?.('.device-details')&&document.activeElement.matches?.('input,select,textarea'))return;
  const s=d.snapshot;
  panel.innerHTML=`<div class="detail-head"><div><div class="eyebrow">DEVICE INSPECTOR / VLAN ${d.vlan}</div><h2>${esc(d.name)} · ${d.ip}</h2><p class="muted">${s?`Checked ${FleetUI.timestamp(s.checkedAt)}`:'Not scanned'} · assigned proxy ${d.proxy}<br>Expected exit ${esc(d.expectedExit||'not commissioned')} · ${esc(d.routeBaselineSource||'Commissioned inventory')}</p></div><span class="pill">${d.health.severity}</span></div>
  <div class="detail-actions"><button data-action="scan">↻ Refresh health & Google apps</button><button data-action="deep">Verify proxy</button><button data-action="clock">Sync time & zone</button><button data-action="proxy">Restore assigned proxy</button><button data-action="accounts">Open account settings</button></div>
  <div class="detail-tabs" role="tablist" aria-label="Device sections"><button role="tab" aria-selected="${detailTab==='health'}" data-detail-tab="health" aria-controls="device-health">Health & accounts</button><button role="tab" aria-selected="${detailTab==='apps'}" data-detail-tab="apps" aria-controls="device-apps">Google & apps</button></div>
  <section id="device-health" ${detailTab==='health'?'':'hidden'}>
    <div class="checks">${d.health.checks.map(c=>`<div class="check ${c.severity}"><strong>${esc(c.key.replaceAll('_',' '))} · ${c.severity}${c.scope==='coverage'?' · verification coverage':''}</strong>${esc(c.message)}</div>`).join('')}</div>
    <div class="account-list"><strong>Linked Google accounts</strong><div>${s?.accounts?.length?s.accounts.map(esc).join('<br>'):s?.accounts===null?'Could not read account inventory':s?.online?'None observed':'Not checked'}</div><small class="muted">Local-only account identifiers. Presence does not prove valid authentication.</small></div>
  </section>
  <section id="device-apps" ${detailTab==='apps'?'':'hidden'}>
    <h2>Google sign-in & Play Store maintenance</h2><p class="muted">Checks read sign-in prompts and update availability. No passwords or automated sign-in. Pause Pandora routines on this phone during maintenance.</p>
    ${state.maintenance?.deviceIds?.includes(d.id)?`<div class="detail-actions"><button data-store-scan="signin">Check Google sign-in</button><button data-store-scan="scan">Scan pending updates</button><button class="primary" data-store-scan="update">Update Apps</button></div><p class="muted">Longer downloads stay in Store for automatic completion sync; background checks never navigate apps.</p>`:'<p class="muted">Store maintenance is unavailable for this device.</p>'}
    ${s?.store?`<div class="check ${s.store.status==='sign_in_required'?'critical':s.store.status==='current'?'healthy':s.store.status==='pending'||s.store.status==='updating'?'warning':'unknown'}"><strong>Last Store observation · ${esc(s.store.status)}</strong>${esc(s.store.message)}<br><small>${esc(s.store.source)} · ${esc(FleetUI.timestamp(s.store.checkedAt))} · ${esc(s.store.restore||'no app navigation')}<br>Evidence expires after 24h or when Android user/accounts/proxy changes. A request is not proof of completed downloads.</small></div>`:''}
    <h2 class="spaced-title">Application availability & updates</h2><p class="muted">Zero updates in Play Store automatically synchronizes this phone's app rows. This means no update offered to this device, not the latest version worldwide. System components are managed separately.</p>
    <div class="table-wrap"><table class="apps-table"><thead><tr><th>App</th><th>Device state</th><th>Update evidence</th><th>Action</th></tr></thead><tbody>${appRows(d,s)}</tbody></table></div>
    ${manualConfirmations(s)}
  </section>
  <section class="maintenance-panel" aria-label="Local AI options"><h2>Local AI options</h2><p class="muted">Optional diagnosis only. No automatic repairs or sign-in; Pandora keeps control of automations.</p><label for="ai-note">What should the worker investigate?</label><textarea id="ai-note" maxlength="2000" rows="2">${esc(aiNote)}</textarea><div class="detail-actions"><button class="primary" data-action="ai">Ask local AI worker</button><small class="muted">Sol · maximum reasoning · separate request</small></div></section>`;
}
function appRows(d,s){
  return state.apps.map(a=>{
    const v=s?.versions?.[a.pkg],e=d.updateEvidence?.[a.pkg],b=state.baselines[`${s?.variant}|${a.pkg}`],auto=d.appEvidence?.[a.pkg];
    const evidence=auto?`<span class="severity-label healthy">No updates offered · auto-synced</span><br><small>${esc(FleetUI.timestamp(auto.at))}</small>`:a.core?'System component · managed separately':e?.pending&&state.now-e.at<7*86400000?'<span class="severity-label warning">Update pending · owner confirmed</span>':b&&state.now-b.confirmedAt<7*86400000?`Baseline ${esc(b.version)} · ${new Date(b.confirmedAt).toLocaleDateString()}`:'Unverified · scan Play Store';
    return `<tr><td>${esc(a.name)}</td><td>${esc(appState(v))}<br>${esc(v?.version||'')}<br><small class="muted">${esc(v?.code||'')}</small></td><td>${evidence}</td><td><button data-store="${a.pkg}">Open Store</button></td></tr>`;
  }).join('');
}
function manualConfirmations(s){
  const list=state.apps.filter(a=>!a.core&&s?.versions?.[a.pkg]?.code&&s.versions[a.pkg].installed!==false);
  if(!list.some(a=>a.pkg===manualPackage))manualPackage=list[0]?.pkg||'';
  return `<section class="maintenance-panel" aria-label="Manual confirmations"><h2>Manual confirmations</h2><p class="muted">Optional fallback if you personally checked Play Store. Automatic scans do not require these confirmations. This records update evidence, not account authentication.</p>
  <div class="manual-controls"><label for="manual-app">App</label><select id="manual-app">${list.map(a=>`<option value="${a.pkg}" ${a.pkg===manualPackage?'selected':''}>${esc(a.name)}</option>`).join('')}</select><button data-manual="current" ${list.length?'':'disabled'}>Confirm up-to-date</button><button data-manual="pending" ${list.length?'':'disabled'}>Mark update pending</button></div></section>`;
}
function appState(v){
  if(!v||v.installed==null)return 'Installation / enabled state not checked';
  if(!v.installed)return 'Not installed for active Android user';
  if(v.hidden||v.suspended)return 'Hidden or suspended';
  return v.enabled===true?'Installed · enabled':v.enabled===false?'Installed · disabled':'Enabled state unreadable';
}
async function refresh(){try{state=await api('/api/state');await loadExpandedResults();$('#live').textContent='● Console connected';render();}catch(e){$('#live').textContent='Console disconnected';toast(e.message);}}
$('#scan-all').onclick=()=>submit({kind:'scan',ids:state.devices.map(d=>d.id)}).catch(e=>toast(e.message));
$('#auto-health').onclick=async()=>{try{await api('/api/monitor',{enabled:!state.monitor?.enabled});await refresh();}catch(e){toast(e.message);}};
$('#deep-all').onclick=()=>confirmAction('Verify all proxy paths?','Read-only checks plus one external geo request per connected device through its assigned proxy. No retries, firewall changes, direct fallback, app launches or sign-in attempts.',()=>submit({kind:'scan',deep:true,ids:state.devices.map(d=>d.id)}));
$('#job-filter').onchange=()=>renderJobs();
document.addEventListener('click',async event=>{const b=event.target.closest('button');if(!b)return;const deviceId=selected;try{
  if(b.dataset.tab){showTab(b.dataset.tab);if(b.dataset.box)$('#box'+b.dataset.box).scrollIntoView({behavior:'smooth',block:'start'});}
  if(b.dataset.results){const id=b.dataset.results;if(expandedJobs.has(id))expandedJobs.delete(id);else expandedJobs.add(id);renderJobs();await loadExpandedResults();renderJobs();}
  if(b.dataset.detailTab){detailTab=b.dataset.detailTab;sessionStorage.setItem('fleet-detail-tab',detailTab);renderDetail();}
  if(b.dataset.device){selected=b.dataset.device;sessionStorage.setItem('fleet-device',selected);const d=state.devices.find(d=>d.id===selected);showTab('servers');render();$('#details').scrollIntoView({behavior:'smooth',block:'start'});}
  if(b.dataset.scan)await submit({kind:'scan',ids:state.devices.filter(d=>d.vlan===Number(b.dataset.scan)).map(d=>d.id)});
  if(b.dataset.cancel){await api('/api/cancel',{id:b.dataset.cancel});await refresh();}
  if(b.dataset.action){const a=b.dataset.action;
    if(a==='scan'||a==='deep')await submit({kind:'scan',ids:[deviceId],deep:a==='deep'});
    else if(a==='ai')confirmAction('Send to separate local AI worker?','Model: gpt-6.1-sol · maximum reasoning. Uses your local Codex sign-in and may consume plan usage. Sends this device’s health evidence, without account email addresses. Diagnosis only; repairs require another confirmation. Maximum run: 5 minutes.',()=>submit({kind:'ai',ids:[deviceId],confirm:true,note:aiNote.trim()||'Diagnose the current health deficiencies and propose the safest next action.'}));
    else confirmAction(`Apply ${a} action?`,a==='clock'?'Sync the device clock and its assigned route timezone. Automatic time/zone will be disabled. Proxy stays unchanged.':a==='proxy'?'Restore only the commissioned Android proxy for this phone and verify its exit. No route rotation, firewall change, or WAN bypass.':'Open account settings on this phone. You complete any sign-in; no credentials are stored.',()=>submit({kind:'repair',action:a,ids:[deviceId],confirm:true}));
  }
  if(b.dataset.storeScan){const action=b.dataset.storeScan;confirmAction(action==='update'?'Update Apps on this phone?':action==='signin'?'Check Google sign-in?':'Scan pending updates?',action==='update'?'Requests Update all for installed apps offered by Play Store on the selected phone only. May use data and restart updated apps. Pandora must be running and bound; no agents installed, no credentials, no proxy/firewall changes. If downloads take longer, Store remains open so monitoring can sync completion automatically. Cancel stops observation, not accepted downloads. Pause Pandora routines on this phone first.':'Opens Play Store maintenance, reads sign-in prompts and pending updates, then reopens the original app. No updates, passwords or purchases. Pause Pandora routines on this phone first.',()=>submit({kind:'store',action,ids:[deviceId],confirm:true}));}
  if(b.dataset.store)confirmAction('Open Play Store on this phone?','This changes the visible app only. It does not press Update or make a purchase.',()=>submit({kind:'repair',action:'store',pkg:b.dataset.store,ids:[deviceId],confirm:true}));
  if(b.dataset.manual==='current')confirmAction('Confirm a Play Store baseline?','Only continue if you have personally checked that this installed version is current in Play Store on this device. Other matching devices below this version will show an orange warning. This does not bypass staged rollouts.',async()=>{await api('/api/baseline',{id:deviceId,pkg:manualPackage,confirm:true});await api('/api/update-evidence',{id:deviceId,pkg:manualPackage,pending:false,confirm:true});});
  if(b.dataset.manual==='pending')confirmAction('Record a pending update?','Confirm only after seeing this app in Play Store’s available updates on this phone. Records an orange warning; installs nothing.',()=>api('/api/update-evidence',{id:deviceId,pkg:manualPackage,pending:true,confirm:true}));
}catch(e){toast(e.message);}});

function renderBox(v,i){
  const list=state.devices.filter(d=>d.vlan===v),sev=severity(list),n=list.filter(d=>d.snapshot?.online&&!d.snapshot?.collectorError).length;
  return `<article class="box ${sev}"><div class="box-head"><div><h3>BOX–PROXY ${i+1}</h3><p>VLAN ${v} · 192.168.${v}.0/24</p></div><div class="count">${n}<small> / 20 reachable</small></div></div>
  <div class="rack"><div class="vents"></div><div class="ports">${list.map((d,j)=>`<button class="port ${d.health.severity} ${selected===d.id?'selected':''}" data-device="${d.id}" title="${esc(d.name)} · ${d.ip} · ${esc(FleetUI.brief(d.health))}"><i></i>${String(j+1).padStart(2,'0')}</button>`).join('')}</div></div>
  <div class="box-footer"><span class="severity-label ${sev}">${sev.toUpperCase()} · ${list.filter(d=>d.health.severity==='healthy').length} operationally healthy</span><button data-scan="${v}">Sync box</button></div>
  <div class="device-list">${list.map(d=>`<button class="device-row" data-device="${d.id}"><span class="device-description"><span><i class="dot ${d.health.severity}"></i>${d.ip} <small>· ${esc(d.name)}</small></span><small class="alarm-reason ${FleetUI.alarms(d.health).length?d.health.severity:gaps(d)?'unknown':'healthy'}">${esc(FleetUI.brief(d.health))}</small></span><span class="severity-label ${d.health.severity}">${d.health.severity}${gaps(d)?` · ${gaps(d)} unverified`:''}</span></button>`).join('')}</div></article>`;
}
function showTab(value){
  activeTab=FleetUI.tab(value);sessionStorage.setItem('fleet-tab',activeTab);
  for(const name of FleetUI.tabs){$('#panel-'+name).hidden=name!==activeTab;const b=$('#tab-'+name);b.classList.toggle('active',name===activeTab);b.setAttribute('aria-selected',String(name===activeTab));b.tabIndex=name===activeTab?0:-1;}
  $('#page-title').textContent={overview:'Your fleet, at a glance.',servers:'Servers & fleets',activity:'Activity & requests'}[activeTab];
  $('#subtitle').textContent=activeTab==='overview'?'40 commissioned devices · 2 server boxes':activeTab==='activity'?'Timestamped requests · health, maintenance and diagnosis':'2 server boxes · VLAN 60 & VLAN 61 · 40 commissioned fleets';
  window.scrollTo({top:0});
}
async function loadExpandedResults(){
  await Promise.all([...expandedJobs].map(async id=>{
    const j=state.jobs.find(j=>j.id===id);if(!j?.hasFindings)return;
    const revision=`${j.status}:${j.done}:${j.finishedAt||''}`,cached=resultCache.get(id);
    if(cached?.revision===revision)return;
    try{const data=await api('/api/job-results?id='+encodeURIComponent(id));resultCache.set(id,{...data,revision});}
    catch{resultCache.set(id,{error:'Could not load saved findings. Close and reopen results to retry.'});}
  }));
}
function renderJobResults(j){
  if(!j.hasFindings)return '<p class="muted">This older request did not retain per-fleet findings. New scans save their results; current live data is not substituted for history.</p>';
  const cached=resultCache.get(j.id);if(!cached)return '<p class="muted">Loading saved findings…</p>';if(cached.error)return `<p class="muted">${esc(cached.error)}</p>`;
  const rows=cached.findings?.rows||[];
  return `<p class="muted">Findings captured by this request. Gray means unverified, not passed. Rows include every targeted fleet, even offline or unchecked devices.</p><div class="results-scroll"><table class="results-table"><thead><tr><th>Fleet / VLAN</th><th>Result</th><th>Findings & checks</th></tr></thead><tbody>${rows.map(r=>`<tr><td><strong>${esc(r.ip)}</strong><br>${esc(r.name)} · VLAN ${r.vlan}<br><small>Observed ${esc(FleetUI.timestamp(r.checkedAt))}</small></td><td><span class="severity-label ${r.severity}">${r.severity==='healthy'?(r.checks.some(c=>c.severity==='unknown')?'Operationally healthy · gaps remain':'All recorded checks passed'):r.severity}</span></td><td>${r.note?`<p>${esc(r.note)}</p>`:''}<p class="passed-checks">${r.checks.some(c=>c.severity==='healthy')?'Passed: '+r.checks.filter(c=>c.severity==='healthy').map(c=>esc(c.key.replaceAll('_',' '))).join(' · '):'No passing checks recorded'}</p><ul class="result-checks">${r.checks.filter(c=>c.severity!=='healthy').sort((a,b)=>['critical','warning','unknown','healthy'].indexOf(a.severity)-['critical','warning','unknown','healthy'].indexOf(b.severity)).map(c=>`<li class="${c.severity}"><strong>${esc(c.key.replaceAll('_',' '))} · ${c.severity}</strong><span>${esc(c.message)}</span></li>`).join('')}</ul></td></tr>`).join('')}</tbody></table></div>`;
}
function renderJobs(){
  const scrolls=new Map([...document.querySelectorAll('[data-result-scroll]')].map(e=>[e.dataset.resultScroll,e.querySelector('.results-scroll')?.scrollTop||0]));
  $('#activity-timezone').textContent='Timestamps use your browser time zone: '+Intl.DateTimeFormat().resolvedOptions().timeZone+'. Requested / started / finished are recorded separately.';
  const jobs=FleetUI.filterJobs(state.jobs,$('#job-filter').value);
  $('#jobs').innerHTML=jobs.length?jobs.map(j=>`<article class="job"><div class="job-head"><strong>${esc(j.kind==='ai'?'AI diagnostic request':j.kind==='repair'?'Repair · '+j.action:j.kind==='store'?'Play Store · '+j.action:j.deep?'Deep health scan':'Health sync')}</strong><span class="pill">${esc(j.status)}</span></div>
  <p class="muted">${j.ids.length===1?esc(state.devices.find(d=>d.id===j.ids[0])?.ip||j.ids[0]):j.ids.length+' devices'} · ${j.source==='monitor'?'Automatic monitor':'Owner request'}</p><p>${esc(j.message)}</p>
  <p class="finding-summary">${esc(FleetUI.findingsSummary(j.findingsSummary))}</p>
  <div class="job-times">${FleetUI.timestamps(j).map(t=>`<div><span>${t.label}</span><time ${t.value?`datetime="${new Date(t.value).toISOString()}"`:''}>${esc(FleetUI.timestamp(t.value))}</time></div>`).join('')}</div>
  <div class="job-controls"><small>${j.startedAt?`Elapsed ${elapsed((j.finishedAt||state.now)-j.startedAt)}`:`Queued ${elapsed(state.now-j.createdAt)} ago`} · ${j.done}/${j.ids.length} · ${j.estimateMs?`Estimated processing ${elapsed(j.estimateMs)} (historical estimate)`:'Completion estimate not yet measured'}</small>
  <button data-results="${j.id}" aria-expanded="${expandedJobs.has(j.id)}" aria-controls="results-${j.id}">${expandedJobs.has(j.id)?'Hide results':'See results'}</button>${['running','queued'].includes(j.status)?`<button data-cancel="${j.id}">Cancel</button>`:''}</div>
  ${['running','queued'].includes(j.status)?`<div class="progress"><progress max="${j.ids.length}" value="${j.done}"></progress></div>`:''}
  <section id="results-${j.id}" data-result-scroll="${j.id}" ${expandedJobs.has(j.id)?'':'hidden'}>${expandedJobs.has(j.id)?renderJobResults(j):''}${j.result?`<h3>AI findings</h3><pre>${esc(j.result)}</pre>`:''}</section></article>`).join(''):'<div class="empty">No matching requests.</div>';
  document.querySelectorAll('[data-result-scroll]').forEach(e=>{const pane=e.querySelector('.results-scroll');if(pane)pane.scrollTop=scrolls.get(e.dataset.resultScroll)||0;});
}
document.addEventListener('input',e=>{if(e.target.id==='ai-note')aiNote=e.target.value;});
document.addEventListener('change',e=>{if(e.target.id==='manual-app')manualPackage=e.target.value;});

document.querySelector('nav[role="tablist"]').addEventListener('keydown',e=>{
  if(!['ArrowDown','ArrowUp','Home','End'].includes(e.key))return;e.preventDefault();
  const i=FleetUI.tabs.indexOf(activeTab),n=e.key==='Home'?0:e.key==='End'?FleetUI.tabs.length-1:(i+(e.key==='ArrowDown'?1:FleetUI.tabs.length-1))%FleetUI.tabs.length;showTab(FleetUI.tabs[n]);$('#tab-'+activeTab).focus();
});
showTab(activeTab);

refresh();setInterval(()=>{if(!document.hidden&&!$('#confirm').open)refresh();},4000);
