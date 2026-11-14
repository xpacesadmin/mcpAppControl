'use strict';

// Application polling, not an AI worker and not a phone-side automation agent.
// Deliberately no catch-up queue, recursive retries, app navigation or repairs.
function createHealthMonitor({enqueue, isBusy, ids, now=Date.now,
  setTimer=setTimeout, clearTimer=clearTimeout, intervalMs=60000}) {
  let enabled=false,timer=null,nextAt=null,lastAt=null,skipped=0,lastError=null;
  function view(){return {enabled,intervalSeconds:intervalMs/1000,nextAt,lastAt,skipped,lastError,deviceCount:ids.length};}
  function schedule(){if(!enabled)return;nextAt=now()+intervalMs;timer=setTimer(tick,intervalMs);timer?.unref?.();}
  function tick(){
    timer=null;nextAt=null;if(!enabled)return;
    if(isBusy())skipped++;
    else {
      try {enqueue({kind:'scan',ids:[...ids],source:'monitor',deep:false});lastAt=now();lastError=null;}
      catch {lastError='Automatic health scan was not queued; will check again next interval';}
    }
    schedule();
  }
  function setEnabled(value){
    enabled=value===true;if(timer!==null)clearTimer(timer);timer=null;nextAt=null;
    if(enabled)schedule();return view();
  }
  return {view,setEnabled,stop:()=>setEnabled(false)};
}
module.exports={createHealthMonitor};
