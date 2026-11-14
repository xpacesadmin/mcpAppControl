'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {createHealthMonitor}=require('../monitor');
function harness(){let cb,clock=1000,busy=false,calls=[],cleared=0;
  const m=createHealthMonitor({ids:['61-210'],enqueue:j=>calls.push(j),isBusy:()=>busy,now:()=>clock,setTimer:(fn,ms)=>{assert.equal(ms,60000);cb=fn;return 1;},clearTimer:()=>{cleared++;cb=null;}});
  return {m,calls,fire:()=>{clock+=60000;cb();},busy:v=>busy=v,get cleared(){return cleared;}};
}
test('monitor starts off, waits 60 seconds, queues only read-only scans',()=>{const h=harness();assert.equal(h.m.view().enabled,false);h.m.setEnabled(true);assert.equal(h.calls.length,0);assert.equal(h.m.view().nextAt,61000);h.fire();assert.deepEqual(h.calls,[{kind:'scan',ids:['61-210'],source:'monitor',deep:false}]);h.m.stop();assert.equal(h.m.view().nextAt,null);});
test('busy scans skipped, never overlap or accumulate catch-up jobs',()=>{const h=harness();h.m.setEnabled(true);h.busy(true);h.fire();h.fire();assert.equal(h.calls.length,0);assert.equal(h.m.view().skipped,2);h.busy(false);h.fire();assert.equal(h.calls.length,1);h.m.stop();});
test('toggle replaces timer and stop prevents stale callbacks from executing',()=>{let cb,calls=0;const m=createHealthMonitor({ids:['61-210'],enqueue:()=>calls++,isBusy:()=>false,setTimer:fn=>{cb=fn;return 1;},clearTimer:()=>{}});m.setEnabled(true);m.stop();cb();assert.equal(calls,0);assert.equal(m.view().enabled,false);});
test('queue failure records generic error without leaking exception details',()=>{let cb;const m=createHealthMonitor({ids:['61-210'],enqueue:()=>{throw Error('private');},isBusy:()=>false,setTimer:fn=>{cb=fn;return 1;},clearTimer:()=>{}});m.setEnabled(true);cb();assert.doesNotMatch(m.view().lastError,/private/);m.stop();});
