'use strict';
const {execFile} = require('node:child_process');
const path = require('node:path');
const {isIPv4} = require('node:net');
const {apps} = require('./inventory');
const {parseSyncStatus,identity}=require('./google-health');
const {freshStore}=require('./store-evidence');
const FRESH_MS = 10*60*1000;
function section(text,key) { return text.split(`__${key}__\n`)[1]?.split(/\n__[A-Z_]+__\n/)[0]?.trim() ?? null; }
function parseSnapshot(raw, at=Date.now()) {
  raw=String(raw).replace(/\r/g,'');
  const accountsText=section(raw,'ACCOUNTS');
  const accounts=[...new Set([...String(accountsText).matchAll(/Account\s*\{name=([^,}]+),\s*type=com\.google\}/g)].map(m=>m[1].trim()))];
  const versions={};
  const enabledText=section(raw,'PACKAGES_ENABLED'),disabledText=section(raw,'PACKAGES_DISABLED');
  const packagesReadable=/ENABLED_RC=0(?:\n|$)/.test(enabledText||'') && /DISABLED_RC=0(?:\n|$)/.test(disabledText||'');
  const enabled=new Set([...String(enabledText).matchAll(/^package:([^\s]+)$/gm)].map(m=>m[1]));
  const disabled=new Set([...String(disabledText).matchAll(/^package:([^\s]+)$/gm)].map(m=>m[1]));
  const user=section(raw,'USER');
  const pkgText=section(raw,'APPS')||'';
  for(const app of apps) {
    const part=pkgText.split(`PACKAGE=${app.pkg}\n`)[1]?.split('PACKAGE=')[0]||'';
    const userLine=/^\d+$/.test(user||'') ? part.split('\n').find(l=>new RegExp(`^\\s*User ${user}:.*installed=`).test(l)) : null;
    versions[app.pkg]={name:app.name,code:part.match(/versionCode=(\d+)/)?.[1]||null,version:part.match(/versionName=([^\n]+)/)?.[1]?.trim()||null,
      installed:packagesReadable ? enabled.has(app.pkg)||disabled.has(app.pkg) : null,
      enabled:packagesReadable && (enabled.has(app.pkg)||disabled.has(app.pkg)) ? enabled.has(app.pkg) : null,
      suspended:userLine ? /suspended=true/.test(userLine) : null,
      hidden:userLine ? /hidden=true/.test(userLine) : null};
  }
  const epoch=Number(section(raw,'EPOCH'));
  const battery=section(raw,'BATTERY')||'';
  return { checkedAt:at, online:true, timezone:section(raw,'TIMEZONE'), locale:section(raw,'LOCALE'),
    proxy:section(raw,'PROXY'), epoch:Number.isFinite(epoch)&&epoch>0?epoch:null,
    drift:Number.isFinite(epoch)&&epoch>0?Math.round(epoch-at/1000):null,
    accounts:accountsText && /Accounts:\s*\d+|Account\s*\{/.test(accountsText)?accounts:null,
    versions, activeUser:user, packagesReadable, variant:section(raw,'VARIANT'), battery:Number(battery.match(/level:\s*(\d+)/)?.[1]??NaN),
    temperature:Number(battery.match(/temperature:\s*(\d+)/)?.[1]??NaN)/10,
    syncAuth:parseSyncStatus(section(raw,'SYNC_AUTH')||'',section(raw,'LOCAL_TIME'),user),
    autoTime:section(raw,'AUTO_TIME'), autoTimezone:section(raw,'AUTO_ZONE') };
}
function classify(device,snapshot,baselines={},now=Date.now()) {
  const checks=[];
  const add=(key,severity,message,scope='operational')=>checks.push({key,severity,message,scope});
  if(!snapshot) return {severity:'unknown',checks:[{key:'scan',severity:'unknown',message:'Not scanned yet'}]};
  if(snapshot.collectorError) { add('collector','unknown',snapshot.collectorError); return {severity:'unknown',checks}; }
  if(!snapshot.online) add('connection','critical','ADB unreachable. This does not prove the phone is powered off.');
  if(snapshot.online) {
    add('connection','healthy','ADB connected');
    add('clock',snapshot.drift===null?'unknown':Math.abs(snapshot.drift)>10?'critical':'healthy',snapshot.drift===null?'Clock unreadable':`Clock offset ${snapshot.drift}s`);
    add('proxy',snapshot.proxy===device.proxy?'healthy':'critical',`Assigned ${device.proxy}; observed ${snapshot.proxy||'unset'}`);
    const geo=snapshot.egress;
    const zone=device.timezone || (geo?.ok && geo.verifiedAt && now-geo.verifiedAt<FRESH_MS && snapshot.proxy===device.proxy?geo.timezone:null);
    add('timezone',!zone?'unknown':snapshot.timezone===zone?'healthy':'critical',`Time zone ${snapshot.timezone||'unknown'}; expected ${zone||'needs exit geo check'}`);
    add('locale',snapshot.locale===device.locale?'healthy':'warning',`Language ${snapshot.locale||'unknown'}; expected ${device.locale}`);
    add('accounts',snapshot.accounts===null?'unknown':!snapshot.accounts.length?'critical':'healthy',snapshot.accounts===null?'Account inventory unreadable':`${snapshot.accounts.length} Google account(s) present — login validity not verified`);
    const auth=snapshot.syncAuth,store=snapshot.store;
    const storeFresh=freshStore(snapshot,now);
    if(storeFresh&&store.status==='sign_in_required')add('account_login','critical',store.message,'coverage');
    else if(auth?.accountCount>0&&auth.recentSuccessAccounts===auth.accountCount&&snapshot.drift!==null&&Math.abs(snapshot.drift)<=10)
      add('account_login','healthy',`Recent successful Google sync for ${auth.accountCount} account(s). App-specific sessions and domain permissions are not certified.`,'coverage');
    else add('account_login','unknown',storeFresh&&['pending','current','updating'].includes(store.status)?'Play Store maintenance is accessible without a sign-in prompt. All Google/app sessions are not proven.':`No fresh authentication proof. ${auth?.historicalAuthErrors||0} historical sync auth error(s) are not treated as a current sign-out.`,'coverage');
    if(auth?.recentAuthErrors)add('google_sync','warning',`Recent service-specific authentication error: ${(auth.authErrorServices||[]).join(', ')||'Google sync'}. Review sign-in/service permissions; this alone does not prove the account is signed out.`,'coverage');
    if(device.expectedAccounts?.length && snapshot.accounts) {
      const missing=device.expectedAccounts.filter(a=>!snapshot.accounts.map(x=>x.toLowerCase()).includes(a.toLowerCase()));
      add('account_assignment',missing.length?'critical':'healthy',missing.length?'Assigned account missing or replaced':'Assigned account present');
    }
    if(!geo) add('egress','unknown','Proxy egress not tested; Sync now includes a probe when evidence is missing');
    else if(now-geo.verifiedAt>FRESH_MS) add('egress','unknown','Proxy egress evidence is stale');
    else if(!geo.proxy || geo.proxy!==device.proxy || snapshot.proxy!==device.proxy) add('egress','unknown','Probe does not match the current configured and assigned proxy; verify again');
    else if(!geo.ok) add('egress',geo.indeterminate?'unknown':'critical',geo.message||'Assigned proxy could not reach the test service');
    else {
      add('egress','healthy',`Device → ${geo.proxy} → ${geo.ip} · HTTPS probe succeeded (not a DNS/WAN leak test)`);
      add('exit_identity',!device.expectedExit?'unknown':geo.ip!==device.expectedExit?'critical':'healthy',!device.expectedExit?`Observed ${geo.ip}; expected exit baseline missing`:geo.ip!==device.expectedExit?`Exit mismatch: ${geo.ip}; assigned ${device.expectedExit}`:`Exit matches commissioned ${device.expectedExit} · ${geo.city||'city unavailable'}`);
    }
    const core=apps.filter(a=>a.core),google=apps.filter(a=>a.google);
    const brokenCore=core.filter(a=>{const v=snapshot.versions?.[a.pkg];return v?.installed===false || v?.enabled===false || v?.suspended===true || v?.hidden===true;});
    const unknownCore=core.filter(a=>{const v=snapshot.versions?.[a.pkg];return !v || v.installed==null || v.enabled==null || v.suspended==null || v.hidden==null;});
    const disabledApps=google.filter(a=>!a.core && snapshot.versions?.[a.pkg]?.installed===true && (snapshot.versions[a.pkg].enabled===false||snapshot.versions[a.pkg].suspended===true||snapshot.versions[a.pkg].hidden===true));
    add('google_apps',brokenCore.length?'critical':unknownCore.length?'unknown':disabledApps.length?'warning':'healthy',brokenCore.length?`Google component unavailable: ${brokenCore.map(a=>a.name).join(', ')}`:unknownCore.length?'Google component state unreadable — refresh with the updated collector':disabledApps.length?`Installed Google app disabled or suspended: ${disabledApps.map(a=>a.name).join(', ')}`:'Play Store / Play services installed and enabled; installed Google apps enabled. This does not test sign-in or playback.');
    let outdated=0,unknown=0,installed=0;
    for(const [pkg,v] of Object.entries(snapshot.versions||{})) {
      if(!v.code || v.installed===false) continue;
      installed++;
      const base=baselines[`${snapshot.variant}|${pkg}`];
      if(!base || now-base.confirmedAt>7*86400000) unknown++;
      else if(BigInt(v.code)<BigInt(base.code)) outdated++;
    }
    const pending=Object.values(device.updateEvidence||{}).filter(e=>e.pending&&now-e.at<7*86400000).length;
    const newerPending=Object.values(device.updateEvidence||{}).some(e=>e.pending&&e.at>store?.checkedAt&&now-e.at<7*86400000);
    const changedVersions=store?.versions&&apps.some(a=>!a.core&&snapshot.versions?.[a.pkg]?.installed&&String(snapshot.versions[a.pkg].code)!==store.versions[a.pkg]);
    if(storeFresh&&['pending','current','updating'].includes(store.status)&&!changedVersions&&!newerPending)add('apps',store.status==='current'?'healthy':'warning',`${store.message} Checked ${new Date(store.checkedAt).toISOString()} for the selected Store account.`,'coverage');
    else add('apps',pending||outdated?'warning':unknown||!installed?'unknown':'healthy',pending?`${pending} pending update(s) confirmed by owner in Play Store`:outdated?`${outdated} app(s) below a confirmed compatible-device baseline`:unknown||!installed?`${unknown} installed app(s) lack a current Play Store baseline; update availability unverified`:'Installed apps meet the confirmed baseline (not a live Play Store check)','coverage');
    if(Number.isFinite(snapshot.temperature)) add('temperature',snapshot.temperature>=48?'critical':snapshot.temperature>=42?'warning':'healthy',`Battery temperature ${snapshot.temperature}°C`);
  }
  if(now-snapshot.checkedAt>FRESH_MS) add('freshness','unknown','Snapshot older than 10 minutes — refresh before acting');
  // Known failures always count. Optional evidence gaps remain visible separately;
  // they must not turn a fully checked operational path gray, or pretend to pass.
  const severity=['critical','warning','unknown','healthy'].find(s=>checks.some(c=>c.severity===s && (s!=='unknown'||c.scope==='operational')))||'unknown';
  return {severity,checks,coverageComplete:!checks.some(c=>c.severity==='unknown')};
}
class Adb {
  constructor(file=process.env.FLEET_ADB||path.join(process.env.LOCALAPPDATA||'', 'Programs/Pandora View Control/tools/adb.exe')) { this.file=file; }
  run(args,signal,timeout=12000) {
    return new Promise((resolve,reject)=>execFile(this.file,args,{timeout,signal,maxBuffer:2*1024*1024,windowsHide:true},(error,stdout,stderr)=>{
      if(error) { const e=new Error(error.killed?'ADB timeout':'ADB command failed'); e.code=error.code; e.stdout=stdout; reject(e); } else resolve(String(stdout));
    }));
  }
  shell(d,command,signal,timeout) { return this.run(['-s',d.serial,'shell',command],signal,timeout); }
  screenshot(d,signal) {
    return new Promise((resolve,reject)=>execFile(this.file,['-s',d.serial,'exec-out','screencap','-p'],{encoding:'buffer',timeout:12000,signal,maxBuffer:16*1024*1024,windowsHide:true},(e,out)=>e?reject(new Error('ADB screenshot unavailable')):resolve(out)));
  }
  async connected(signal) {
    const out=await this.run(['devices'],signal);
    if(!out.includes('List of devices attached')) throw new Error('ADB inventory unavailable');
    return new Set(out.split(/\r?\n/).filter(l=>/\sdevice$/.test(l.trim())).map(l=>l.trim().split(/\s/)[0]));
  }
  async snapshot(d,signal) {
    const parts=[['USER','echo "$fleet_user"'],['EPOCH','date +%s'],['TIMEZONE','getprop persist.sys.timezone'],['LOCALE','getprop persist.sys.locale'],['PROXY','settings get global http_proxy'],['AUTO_TIME','settings get global auto_time'],['AUTO_ZONE','settings get global auto_time_zone'],['VARIANT','echo $(getprop ro.product.model)/$(getprop ro.build.version.sdk)/$(getprop ro.product.cpu.abi)'],['ACCOUNTS',"dumpsys account | grep -E 'Accounts:|Account \\{name='"],['BATTERY','dumpsys battery'],['PACKAGES_ENABLED','pm list packages -e --user "$fleet_user"; echo ENABLED_RC=$?'],['PACKAGES_DISABLED','pm list packages -d --user "$fleet_user"; echo DISABLED_RC=$?'],['APPS',apps.map(a=>`echo PACKAGE=${a.pkg}; dumpsys package ${a.pkg} | grep -E 'versionCode=|versionName=|User [0-9]+:'`).join('; ')]];
    parts.push(['LOCAL_TIME','date +%Y-%m-%dT%H:%M:%S'],['SYNC_AUTH',"dumpsys content | sed -n '/^Sync Status/,/^Detailed Statistics/p'"]);
    const command='fleet_user=$(am get-current-user); case "$fleet_user" in ""|*[!0-9]*) exit 1;; esac; '+parts.map(([k,v])=>`echo __${k}__; ${v}`).join('; ')+'; echo __END__';
    return parseSnapshot(await this.shell(d,command,signal,20000));
  }
  async egress(d,signal) {
    // Explicit proxy AND empty no-proxy list. No fallback to a direct path.
    try {
      if(!/^192\.168\.52\.10:\d{4}$/.test(d.proxy)) throw new Error('Invalid commissioned proxy');
      const text=await this.shell(d,`curl -q -4 -fsS --retry 0 --noproxy '' --connect-timeout 4 --max-time 10 --proxy http://${d.proxy} --proto '=https' https://ipinfo.io/json`,signal,12000);
      const geo=JSON.parse(text);
      if(!isIPv4(geo.ip||'')) throw new Error('Invalid exit response');
      return {ok:true,proxy:d.proxy,ip:geo.ip,city:String(geo.city||'').slice(0,80),country:geo.country,timezone:geo.timezone,verifiedAt:Date.now()};
    } catch(error) { if(signal?.aborted) throw error;
      const messages={127:'curl is unavailable on this phone',22:'The external probe service returned an HTTP error',60:'Probe TLS certificate validation failed',7:'Cannot connect to the assigned proxy',28:'Assigned proxy probe timed out'};
      const indeterminate=[127,22,60].includes(error.code)||!Number.isInteger(error.code);
      return {ok:false,proxy:d.proxy,indeterminate,message:`${messages[error.code]||'Proxy probe did not return a valid result'}; no direct fallback attempted`,verifiedAt:Date.now()}; }
  }
  async repair(d,action,snapshot,signal,pkg) {
    if(action==='clock') {
      const zone=d.timezone || (snapshot?.egress?.ok && Date.now()-snapshot.egress.verifiedAt<FRESH_MS && snapshot.proxy===d.proxy?snapshot.egress.timezone:null);
      if(!zone || !/^[A-Za-z_]+\/[A-Za-z_+/-]+$/.test(zone)) throw new Error('A verified route timezone is required');
      const before=await this.snapshot(d,signal);
      if(before.proxy!==d.proxy) throw new Error('Proxy assignment mismatch. Resolve it before clock stabilization.');
      for(const cmd of ['settings put global auto_time 0','settings put global auto_time_zone 0',`cmd alarm set-timezone ${zone}`,`cmd alarm set-time ${Date.now()}`]) {
        try { await this.shell(d,cmd,signal); } catch(e) { if(e.code!==255 || !cmd.startsWith('cmd alarm ')) throw e; }
      }
      const after=await this.snapshot(d,signal);
      if(after.drift===null || Math.abs(after.drift)>10 || after.timezone!==zone || after.proxy!==before.proxy) throw new Error('Clock repair postconditions failed; inspect device');
      return {snapshot:after,message:'Clock and timezone verified. Proxy unchanged.'};
    }
    if(action==='proxy') {
      // Restore only this device's commissioned Android proxy. Never remove it.
      await this.shell(d,`settings put global http_proxy ${d.proxy}`,signal);
      const after=await this.snapshot(d,signal); after.egress=await this.egress(d,signal);
      if(after.proxy!==d.proxy || !after.egress.ok || (d.expectedExit && after.egress.ip!==d.expectedExit)) throw new Error('Assigned proxy restored, but end-to-end verification failed. No WAN bypass was enabled.');
      return {snapshot:after,message:'Assigned proxy restored and verified'};
    }
    if(action==='accounts') { await this.shell(d,'am start -a android.settings.SYNC_SETTINGS',signal); return {message:'Account settings opened. Sign-in remains owner-operated.'}; }
    if(action==='store') {
      if(!apps.some(a=>a.pkg===pkg)) throw new Error('Package not allowlisted');
      await this.shell(d,`am start -a android.intent.action.VIEW -d market://details?id=${pkg} -p com.android.vending`,signal);
      return {message:'Play Store opened; no update or purchase was submitted.'};
    }
    throw new Error('Unsupported repair');
  }
}
module.exports={Adb,parseSnapshot,classify,FRESH_MS};
