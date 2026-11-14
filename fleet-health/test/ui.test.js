'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ui=require('../public/ui-model');
test('activity has exact timestamps and supports focused filters',()=>{
  assert.equal(ui.timestamp(null),'—');assert.equal(ui.timestamp(undefined),'—');assert.notEqual(ui.timestamp(1794537301043),'—');
  const j={kind:'repair',createdAt:1,startedAt:2,finishedAt:3};assert.deepEqual(ui.timestamps(j).map(x=>x.label),['Requested','Started','Finished']);
  assert.equal(ui.filterJobs([{kind:'scan'},j],'actions').length,1);assert.equal(ui.filterJobs([{kind:'scan'},j],'health').length,1);
});
test('dashboard has distinct panels and selecting tabs preserves only one visible panel',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
  assert.equal((html.match(/class="nav(?: active)?"/g)||[]).length,3);
  assert.match(html,/id="box60"/);assert.match(html,/id="box61"/);
  for(const name of ui.tabs){assert.match(html,new RegExp(`id="panel-${name}"`));assert.match(html,new RegExp(`aria-controls="panel-${name}"`));}
  assert.equal(ui.tab('unsafe'),'overview');
  const elements=new Map(),storage=new Map();
  function element(key){if(!elements.has(key))elements.set(key,{hidden:false,innerHTML:'',textContent:'',value:'actions',classList:{toggle(){},add(){},remove(){}},setAttribute(){},addEventListener(){},focus(){},scrollIntoView(){}});return elements.get(key);}
  const context={FleetUI:ui,sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},location:{hash:'',pathname:'/'},history:{replaceState(){}},document:{querySelector:element,querySelectorAll:()=>[],addEventListener(){}},window:{scrollTo(){}},setTimeout(){},setInterval(){},fetch:async()=>({ok:true,json:async()=>({devices:[],jobs:[],apps:[],baselines:{},now:Date.now()})}),Intl,Date,console};
  vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8'),context);
  for(const name of ui.tabs){context.showTab(name);for(const other of ui.tabs)assert.equal(element('#panel-'+other).hidden,other!==name);assert.equal(storage.get('fleet-tab'),name);}
});
