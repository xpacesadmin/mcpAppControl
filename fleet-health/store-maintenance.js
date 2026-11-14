'use strict';
const {execFile}=require('node:child_process');
const path=require('node:path');
const {setTimeout:pause}=require('node:timers/promises');
const STORE='com.android.vending';
function localOcr(png,signal) {
  return new Promise((resolve,reject)=>{
    const child=execFile('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'ocr-screen.ps1')],
      {signal,timeout:20000,maxBuffer:2*1024*1024,windowsHide:true},(e,out)=>{
        if(e)return reject(new Error('Local Windows English OCR unavailable; no device action taken'));
        try{resolve(JSON.parse(out.replace(/^\uFEFF/,'')));}catch{reject(new Error('Local OCR returned invalid data'));}
      });
    child.stdin.on('error',()=>{});child.stdin.end(png.toString('base64'));
  });
}
function screenState(screen) {
  const text=screen.lines.map(l=>l.text).join('\n');
  if(/authentication (?:is )?required|sign in to (?:your )?google|verify (?:it.s|that it.s) you|sign in again|account action required/i.test(text)||/^sign in$/im.test(text))
    return {status:'sign_in_required',message:'Play Store is requesting sign-in/verification. Complete it manually; no credentials collected.'};
  if(/you.re offline|no internet|something went wrong|try again|error retrieving|couldn.t connect/i.test(text))
    return {status:'unavailable',message:'Play Store reports a connection/loading error; this is not classified as an expired login.'};
  const count=text.match(/available updates?\s*\(?\s*(\d+)\s*\)?/i)||text.match(/(\d+)\s+(?:updates? (?:available|pending)|apps? pending)/i);
  if(count&&Number(count[1])>0&&/update all|cancel all/i.test(text))return {status:'pending',count:Number(count[1]),message:`Play Store lists ${Number(count[1])} available updates.`,updating:/cancel all|installing|pending\.\.\.|downloading/i.test(text)};
  if(/all apps (?:are )?up to date|no (?:updates|updates available)/i.test(text))return {status:'current',count:0,updating:false,message:'Play Store reports all apps up to date.'};
  // Empty download queue alone does not prove no updates are offered.
  if(/cancel all|installing|downloading|pending\.\.\./i.test(text)&&/downloads|updates/i.test(text))return {status:'updating',message:'Play Store is processing updates; completion has not been verified.'};
  return {status:'unknown',message:'Play Store layout/status not recognized. No blind taps or sign-in attempts.'};
}
function target(screen,regex) {
  // Some OCR lines contain a label plus a right-aligned button. Match the words
  // of that button, never the bounding box of the entire combined line.
  for(const l of screen.lines) {
    const words=l.words||[];
    for(let n=1;n<=5;n++)for(let i=0;i+n<=words.length;i++) {
      const part=words.slice(i,i+n);
      if(regex.test(part.map(w=>w.text).join(' '))) {
        const x=Math.min(...part.map(w=>w.x)),y=Math.min(...part.map(w=>w.y));
        const r=Math.max(...part.map(w=>w.x+w.width)),b=Math.max(...part.map(w=>w.y+w.height));
        if(x>=0&&y>=0&&r<=screen.width&&b<=screen.height)return {x:Math.round((x+r)/2),y:Math.round((y+b)/2)};
      }
    }
  }
  return null;
}
class StoreMaintenance {
  constructor(adb,{ocr=localOcr,wait=(ms,s)=>pause(ms,undefined,{signal:s})}={}) {this.adb=adb;this.ocr=ocr;this.wait=wait;}
  async guard(d,signal) {
    const out=await this.adb.shell(d,"echo __PROXY__; settings get global http_proxy; echo __SERVICES__; settings get secure enabled_accessibility_services; echo __PANDORA__; pidof pro.pandorabox.pandora; echo __BOUND__; dumpsys accessibility | grep 'Service\\[.*packageName=pro.pandorabox.pandora'; echo __TOP__; dumpsys activity activities | grep mResumedActivity",signal);
    const val=k=>out.split(`__${k}__`)[1]?.split(/__[A-Z]+__/)[0]?.trim()||'';
    return {proxy:val('PROXY'),services:val('SERVICES'),pandora:val('PANDORA'),bound:!!val('BOUND'),top:val('TOP').match(/\bu\d+ ([a-zA-Z0-9_.$]+\/[a-zA-Z0-9_.$]+)/)?.[1]||null};
  }
  same(before,after) {
    if(before.proxy!==after.proxy||before.services!==after.services||!after.pandora||!after.bound)throw new Error('Maintenance halted: proxy or Pandora guard changed. No settings were repaired or overridden.');
  }
  async screen(d,before,signal) {
    let g=await this.guard(d,signal);this.same(before,g);
    if(!g.top?.startsWith(STORE+'/'))throw new Error('Play Store is not foreground; another controller may be active. Maintenance stopped.');
    const screen=await this.ocr(await this.adb.screenshot(d,signal),signal);
    g=await this.guard(d,signal);this.same(before,g);
    if(!g.top?.startsWith(STORE+'/'))throw new Error('Foreground changed during inspection; no tap sent.');
    return screen;
  }
  async tap(d,before,screen,regex,signal) {
    const t=target(screen,regex);if(!t)throw new Error('Expected Store button not recognized; no tap sent.');
    const fresh=await this.screen(d,before,signal),f=target(fresh,regex);
    if(!f||Math.abs(t.x-f.x)>15||Math.abs(t.y-f.y)>15)throw new Error('Store layout changed; no tap sent.');
    await this.adb.shell(d,`input tap ${f.x} ${f.y}`,signal);
  }
  async observe(d,signal) {
    // The 60s monitor never launches apps or taps. Only read a Store screen the
    // operator already left open. Unknown screens do not erase valid evidence.
    const guard=await this.guard(d,signal);
    if(guard.proxy!==d.proxy||!guard.pandora||!guard.bound||!guard.top?.startsWith(STORE+'/'))return null;
    const read=screenState(await this.screen(d,guard,signal));
    return read.status==='unknown'?null:{...read,checkedAt:Date.now(),source:'Visible Play Store screen · passive local OCR',pandoraPreserved:true,proxyUnchanged:true};
  }
  async run(d,{update=false,signal,onProgress=()=>{}}={}) {
    const before=await this.guard(d,signal);
    if(before.proxy!==d.proxy)throw new Error('Assigned proxy mismatch. Store maintenance refused; proxy unchanged.');
    if(!before.pandora||!before.bound)throw new Error('Pandora must be running and bound before Store maintenance; nothing enabled automatically.');
    let result,restore='not needed';
    try {
      onProgress('Opening Play Store maintenance; Pandora remains enabled');
      await this.adb.shell(d,'am start -a com.google.android.finsky.VIEW_MY_DOWNLOADS -p com.android.vending',signal);
      await this.wait(4000,signal);
      let screen=await this.screen(d,before,signal),read=screenState(screen);
      // At most three recognized navigation/check buttons; no coordinate macros.
      for(let n=0;n<3;n++) {
        if(['sign_in_required','unavailable'].includes(read.status))break;
        let button=target(screen,/^Check for updates$/i)?/^Check for updates$/i:
          read.status==='unknown'&&target(screen,/^(?:See details|Updates available|Manage apps [&＆] device)$/i)?/^(?:See details|Updates available|Manage apps [&＆] device)$/i:null;
        if(!button)break;
        // A single refresh is sufficient; avoid repeated Check for updates loops.
        await this.tap(d,before,screen,button,signal);await this.wait(5000,signal);
        screen=await this.screen(d,before,signal);read=screenState(screen);
        if(button.source==='^Check for updates$')break;
      }
      result={...read,checkedAt:Date.now(),source:'Play Store screen · local English OCR',updateRequested:false};
      if(update&&read.status==='pending'&&!read.updating) {
        onProgress(`Requesting ${read.count} Play Store updates on this phone only`);
        await this.tap(d,before,screen,/^Update all$/i,signal);result.updateRequested=true;
        // Bounded observation, not an endless download watchdog. Cancellation
        // cannot undo a request that Play Store already accepted.
        for(let i=0;i<6;i++) {
          await this.wait(5000,signal);screen=await this.screen(d,before,signal);read=screenState(screen);
          result={...result,...read,checkedAt:Date.now()};onProgress(read.message);
          if(['current','sign_in_required','unavailable'].includes(read.status))break;
        }
        if(result.status!=='current')result.message='Update request sent. '+result.message+' Store will remain open so the 60-second monitor can sync completion automatically. Returning to another app pauses screen-based completion detection.';
      }
      return result;
    } finally {
      // Restore only the originally observed component while Store still owns
      // the foreground. Never override another controller or force-stop apps.
      const after=await this.guard(d).catch(()=>null);
      const leaveOpen=!signal?.aborted&&result?.updateRequested&&['pending','updating'].includes(result.status);
      if(after){this.same(before,after);if(leaveOpen&&after.top?.startsWith(STORE+'/'))restore='Store left open for automatic completion sync';
      else if(before.top&&!before.top.startsWith(STORE+'/')&&after.top?.startsWith(STORE+'/')) {
        await this.adb.shell(d,`am start -n ${before.top}`).catch(()=>{restore='failed';});if(restore!=='failed')restore='original app reopened';
      } else if(after.top!==before.top)restore='skipped: foreground changed';}
      else throw new Error('Final Pandora/proxy guard unreadable. Maintenance result is not verified.');
      const final=await this.guard(d);this.same(before,final);
      if(result){result.pandoraPreserved=!!final.pandora&&final.bound;result.proxyUnchanged=final.proxy===before.proxy;result.restore=restore;}
    }
  }
}
module.exports={StoreMaintenance,screenState,target,localOcr};
