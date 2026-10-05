import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {apply} from '../lib/recipes.mjs';
import {approveRecipe} from '../lib/recipe-integrity.mjs';
import {RECIPES_DIR} from '../lib/dsh-paths.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createPtcFixture} from './helpers/ptc-runtime.mjs';
const executeFile=promisify(execFile);
const verifyCommand='node --test --test-isolation=none test.js';
async function executeVerification(root) {
 let stdout='',stderr='',exitCode=0;
 try { ({stdout,stderr}=await executeFile(process.execPath,['--test','--test-isolation=none','test.js'],{cwd:root,timeout:10000})); }
 catch(error) { if(typeof error.code!=='number')throw error; exitCode=error.code;stdout=error.stdout;stderr=error.stderr; }
 return {command:verifyCommand,exitCode,passed:exitCode===0,evidence:(stdout+stderr).trim()};
}
const command=(command='node --test',exitCode=0)=>({command,exitCode,evidence:'observed defect assertion output',passed:exitCode===0});
const expectedLabels={
 'feature-pipeline':['setup','analysis','implement #1','review-1 #1','review-2 #1','validate'],
 'bug-fix':['analysis','implement #1','review-1 #1','review-2 #1','validate'],
 'refactor':['analysis','baseline','implement #1','review-1 #1','review-2 #1','validate'],
 'code-audit':['scope','scan-security','scan-correctness','verify'],
 'investigate':['scope','gather','check'],
 'plan-to-packages':['evidence','packages','check'],
 'qa-verify':['analysis','verify','check'],
};
const expectedRoles={
 'feature-pipeline':['setup','analysis','implement','r1','r2','validate'],
 'bug-fix':['analysis','implement','r1','r2','validate'],
 'refactor':['analysis','baseline','implement','r1','r2','validate'],
 'code-audit':['scope','scan-security','scan-correctness','verify'],
 'investigate':['scope','gather','check'],
 'plan-to-packages':['evidence','packages','check'],
 'qa-verify':['analysis','verify','check'],
};
const examples={
 'feature-pipeline':{setup:{stack:'JS',testCommands:['node --test'],lintCommands:[],conventions:[]},analysis:{scope:{files:['src.js'],symbols:[],dependents:[],tests:[]},currentState:'source exists',gaps:['scoped change'],outcome:'proceed',outcomeReason:'scoped task',decisions:[],compactSpec:{impact:'local',files:['src.js'],acceptance:['Requested behavior'],verifyCommands:['node --test'],plan:'Update src.js and verify'}},implement:{changedPaths:['src.js'],commands:[command()],notes:'changed',decisions:[]},'review-1':{verdict:'APPROVED',summary:'verified',findings:[]},'review-2':{verdict:'APPROVED',summary:'verified',findings:[]},validate:{commands:[command()],results:[{criterion:'Requested behavior',status:'passed',evidence:'observed test'}],summary:'verified'}},
 'qa-verify':{analysis:{files:['src.js'],criteria:[{id:'criterion-one',criterion:'Expected source contract',basis:'explicit task',files:['src.js'],proof:'source',commands:[],limitedBy:[]}],commands:[],complete:true,limitations:[]},verify:{results:[{id:'criterion-one',status:'passed',proof:'source',evidence:'inspected source',files:['src.js'],commands:[]}],commands:[],coverage:['src.js'],complete:true,limitations:[]},check:{results:[{id:'criterion-one',status:'passed',proof:'source',evidence:'independent source',files:['src.js'],commands:[],reason:'explicit criterion met'}],commands:[],coverage:['src.js'],complete:true,limitations:[]}},
 'refactor':{analysis:{verifyCommands:['node --test'],files:['src.js','test.js'],tests:['test.js'],invariants:['Behavior unchanged'],acceptance:['Structure improved'],clear:true,questions:[],evidence:'source'},baseline:{commands:[command()],evidence:'untouched passing tests'},implement:{changedPaths:['src.js'],commands:[command()],behaviorChanged:false,testsWeakened:false,notes:'restructure'},'review-1':{verdict:'APPROVED',findings:[],evidence:'diff checked'},'review-2':{verdict:'APPROVED',findings:[],evidence:'diff checked'},validate:{invariants:[{criterion:'Behavior unchanged',passed:true,evidence:'tests'}],acceptance:[{criterion:'Structure improved',passed:true,evidence:'diff'}],commands:[command()],behaviorChanged:false,testsWeakened:false,evidence:'fresh tests'}},
 'plan-to-packages':{evidence:{goals:[{id:'goal-one',description:'Deliver scoped change'}],files:['package.json','src.js'],commands:[{command:'node --test',file:'package.json',evidence:'test script'}],complete:true,questions:[]},packages:{packages:[{id:'package-one',title:'Scoped change',description:'Implement goal',writePaths:['src.js'],acceptance:['Goal fulfilled'],verifyCommands:['node --test'],dependencies:[],goalIds:['goal-one'],recipe:'feature-pipeline',serializationReason:'',evidence:'src.js inspected'}],complete:true,questions:[]},check:{packages:[{id:'package-one',passed:true,evidence:'scope verified'}],goals:[{id:'goal-one',passed:true,evidence:'goal covered'}],complete:true,questions:[]}},
 'investigate':{scope:{files:['src.js'],summary:'source scope',complete:true,limitations:[]},gather:{hypotheses:[{id:'one',cause:'Incorrect boundary',file:'src.js',line:1,evidence:'source evidence',confidence:0.8}],coverage:['src.js'],complete:true,limitations:[]},check:{resolutions:[{id:'H1',status:'confirmed',reason:'source verified',evidence:'src.js:1 evidence',confidence:0.8}],coverage:['src.js'],complete:true,limitations:[],next_actions:['Reproduce defect before repair']}},
 'code-audit':{scope:{files:['src.js'],summary:'Scoped source',complete:true,limitations:[]},'scan-security':{findings:[],coverage:['src.js'],complete:true,limitations:[]},'scan-correctness':{findings:[],coverage:['src.js'],complete:true,limitations:[]},verify:{resolutions:[],coverage:['src.js'],complete:true,limitations:[]}},
 'bug-fix':{analysis:{setup:{stack:'JS',verifyCommands:['node --test'],conventions:[]},analysis:{scope:{files:['src.js','test.js'],tests:['test.js'],symbols:[],dependents:[]},outcome:'reproducible',reason:'Source confirms bug',currentState:'wrong',expectedBehavior:'right',acceptance:['Regression fixed'],decisions:[]}},implement:{changedPaths:['src.js','test.js'],commands:[command()],regression:{red:{...command('node --test test.js',1),failureKind:'assertion',testExecuted:true},green:command('node --test test.js'),beforeProduction:true},notes:'fixed',decisions:[]},'review-1':{verdict:'APPROVED',summary:'verified',findings:[]},'review-2':{verdict:'APPROVED',summary:'verified',findings:[]},validate:{results:[{criterion:'Regression fixed',status:'passed',evidence:'actual tests'}],commands:[command(),command('node --test test.js')],summary:'verified'}}
};
for(const name of ['feature-pipeline','code-audit','bug-fix','investigate','plan-to-packages','refactor','qa-verify'])test(name+' actual saved body crosses run_recipe and real PTC engine',{timeout:60000},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'new-recipe-worker-'));let tool,runtime;const listeners=new Map(),requests=[],observedCommands=[],disposedChildren=new Set();
 try{const dir=path.join(root,'recipes'),base=path.join(dir,name);await mkdir(base,{recursive:true});
 const verifiesLocally=['bug-fix','refactor'].includes(name);
 if(verifiesLocally){
  await writeFile(path.join(root,'src.js'),`module.exports = value => value ${name==='bug-fix'?'-':'+'} 1;\n`);
  await writeFile(path.join(root,'test.js'),"const {test}=require('node:test');const assert=require('node:assert/strict');test('increment preserves requested behavior',()=>assert.equal(require('./src.js')(2),3));\n");
 }
 for(const file of ['meta.json','script.js'])await writeFile(path.join(base,file),await readFile(path.join(RECIPES_DIR,name,file),'utf8'));
 await approveRecipe(base,{approvedBy:'offline-fixture-not-production'});
 const provider={capabilities:{agentOptions:true,outputSchema:true,toolFilter:true},inheritsParentContext:false,async start(req){requests.push(req);const requestIndex=requests.length;const markerLabel=req.descriptor?.label;
 // Labels are on the one-shot descriptor supplied by the actual engine/registry.
 const label=markerLabel??req.descriptor?.workflow?.label??expectedLabels[name][requestIndex-1];
 const value=structuredClone(examples[name][label.replace(/ #\d+$/,'')]);assert.ok(value,'known fixture label '+label);
 if(verifiesLocally){
  if(label==='analysis'){
   if(name==='bug-fix')value.setup.verifyCommands=[verifyCommand];else value.verifyCommands=[verifyCommand];
   assert.equal(await readFile(path.join(root,'src.js'),'utf8'),`module.exports = value => value ${name==='bug-fix'?'-':'+'} 1;\n`,'preparation does not edit production');
  }
  if(label==='baseline'){
   assert.equal(await readFile(path.join(root,'src.js'),'utf8'),'module.exports = value => value + 1;\n','baseline executes untouched source');
   value.commands=[await executeVerification(root)];observedCommands.push({label,...value.commands[0]});
  }
  if(label==='implement #1'){
   let red;
   if(name==='bug-fix'){
    red=await executeVerification(root);observedCommands.push({label:'red',...red});
    assert.equal(red.exitCode,1);assert.match(red.evidence,/ERR_ASSERTION/);
    assert.equal(await readFile(path.join(root,'src.js'),'utf8'),'module.exports = value => value - 1;\n','RED precedes production repair');
   }
   await writeFile(path.join(root,'src.js'),'module.exports = value => 1 + value;\n');
   const green=await executeVerification(root);observedCommands.push({label:'green',...green});assert.equal(green.exitCode,0);
   value.commands=[green];
   if(name==='bug-fix')value.regression={red:{...red,failureKind:'assertion',testExecuted:true},green,beforeProduction:true};
  }
  if(label.startsWith('review-')||label==='validate'){
   const fresh=await executeVerification(root);observedCommands.push({label,...fresh});assert.equal(fresh.exitCode,0);
   if(label==='validate')value.commands=[fresh];else value.evidence=fresh.evidence;
  }
 }
 return{id:'fixture-'+requestIndex,result:Promise.resolve({stopReason:'completed',output:[],structured:value}),async dispose(){disposedChildren.add(requestIndex);}};
 }};
 const providers=new Map([['spawn',provider]]);const ctx={logger:{warn(){}},tools:{register:t=>tool=t},on(n,fn){const s=listeners.get(n)??new Set();s.add(fn);listeners.set(n,s);return()=>s.delete(fn);},emit(n,...a){for(const fn of listeners.get(n)??[])fn(...a);},events:{dispatch(_k,[n,...a]){return[...(listeners.get(n)??[])].map(fn=>()=>fn(...a));}},subagents:{getProvider:n=>providers.get(n),registerProvider(p){providers.set(p.name,p);return()=>providers.delete(p.name);},start(n,r){return providers.get(n).start(r);}},subagentModelSelection:{current:()=>({enabled:true,allowedModels:['A','B','C'].map(model=>({provider:'fixture',model})),modelTiers:['A','B','C'].map(model=>({provider:'fixture',model,tier:'strong'}))})},llm:{listProviders:()=>[{id:'fixture'}],resolveCallConfig:async c=>c}};
 runtime=await createPtcFixture({cwd:root,provider,events:ctx});ctx.subagents=runtime.subagents;ctx.workflowEngine=runtime.engine;
 apply(ctx,{recipesDir:dir,runsDir:path.join(root,'runs'),setupCacheDir:path.join(root,'cache')});
 const parent=runtime.createParent();
 const result=await tool.execute({recipe:name,repo:root,task:'offline worker fixture'},{agent:parent,signal:new AbortController().signal});
 assert.equal(result.result.status,'completed');assert.equal(requests.length,expectedLabels[name].length);
 const children=parent.session.snapshotEvents().filter(e=>e.type==='auto-recipe/agent-start');
 assert.deepEqual(children.map(e=>e.data.label).sort(),[...expectedLabels[name]].sort(),'durable labels match actual published children; parallel publication may reorder reviewers');
 assert.deepEqual(children.map(e=>[e.data.label,e.data.role]).sort(),expectedLabels[name].map((label,index)=>[label,expectedRoles[name][index]]).sort(),'durable roles match the published recipe stages');
 assert.ok(children.every(e=>typeof e.data.role==='string'&&e.data.provider==='fixture'));
 for(const [index,label] of expectedLabels[name].entries())if(['setup','analysis'].includes(label))assert.deepEqual(requests[index].toolFilter,{allow:['read','read_image','glob','grep']});
 if(['code-audit','investigate','plan-to-packages'].includes(name))for(const req of requests)assert.deepEqual(req.toolFilter,{allow:['read','read_image','glob','grep']});
 assert.ok(requests.every(req=>req.agentOptions.provider==='fixture'));
 const implementation=expectedLabels[name].indexOf('implement #1');
 if(implementation>=0)for(const [index,label] of expectedLabels[name].entries())if(label.startsWith('review-'))assert.notEqual(requests[index].agentOptions.model,requests[implementation].agentOptions.model,'reviewer route differs from implementer');
 assert.deepEqual(runtime.subagents.list(), ['spawn'], 'the private route provider is removed after settlement');
 assert.equal(disposedChildren.size,requests.length,'every published fixture child is disposed before settlement');
 if(verifiesLocally){
  assert.deepEqual(observedCommands.slice(0,2).map(row=>row.label),name==='bug-fix'?['red','green']:['baseline','green']);
  assert.deepEqual(observedCommands.slice(2,4).map(row=>row.label).sort(),['review-1 #1','review-2 #1']);
  assert.equal(observedCommands.at(-1).label,'validate');
  assert.ok(observedCommands.every(row=>row.command===verifyCommand&&row.evidence.includes('increment preserves requested behavior')));
  assert.equal(await readFile(path.join(root,'test.js'),'utf8'),"const {test}=require('node:test');const assert=require('node:assert/strict');test('increment preserves requested behavior',()=>assert.equal(require('./src.js')(2),3));\n",'verification preserves the original assertion');
 }
 }finally{try{await runtime?.dispose();}finally{await rm(root,{recursive:true,force:true});}}
});
