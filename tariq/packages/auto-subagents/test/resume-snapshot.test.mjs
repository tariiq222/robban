import assert from 'node:assert/strict'; import {test} from 'node:test';
import {mkdtemp,writeFile,rm,readdir,utimes,readFile} from 'node:fs/promises'; import path from 'node:path'; import os from 'node:os';
import {scopeSnapshot,claimResume,saveResume,loadResume,pruneRuns,CLAIM_TTL_MS} from '../lib/recipes.mjs';
const tmp=()=>mkdtemp(path.join(os.tmpdir(),'ars-runs-'));
const DEAD_PID=2**22+12345; // above the pid range of macOS/Linux defaults

test('stale readers cannot claim a consumed persisted resume token',async()=>{
 const dir=await tmp();
 try{ const id=await saveResume({consumed:true},dir); await assert.rejects(claimResume(id,{consumed:false},'/tmp',dir),/already used/); }
 finally{await rm(dir,{recursive:true,force:true});}
});
test('scoped freshness and atomic claim prevent stale or concurrent resumes',async()=>{
 const dir=await tmp(); const repo=await mkdtemp(path.join(os.tmpdir(),'ars-scope-'));
 await writeFile(path.join(repo,'a.js'),'one');
 const scopeHashes=await scopeSnapshot(repo,{files:['a.js']});
 const id=await saveResume({},dir);
 try {
  const release=await claimResume(id,{scopeHashes},repo,dir);
  assert.equal(JSON.parse(await readFile(path.join(dir,`${id}.claim`),'utf8')).pid,process.pid,'claim records its owner');
  await assert.rejects(claimResume(id,{scopeHashes},repo,dir),/already being used/,'live owner keeps the claim');
  await release();
  await writeFile(path.join(repo,'a.js'),'changed');
  await assert.rejects(claimResume(id,{scopeHashes},repo,dir),/Scoped files changed/);
 }finally{await rm(dir,{recursive:true,force:true});await rm(repo,{recursive:true,force:true});}
});
test('a claim left by a dead process is reclaimed',async()=>{
 const dir=await tmp();
 try{
  const id=await saveResume({},dir);
  await writeFile(path.join(dir,`${id}.claim`),JSON.stringify({pid:DEAD_PID,createdAt:Date.now()}));
  const release=await claimResume(id,{},'/tmp',dir);
  await release();
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('F2: a live owner is never robbed, even past the TTL; dead or unknown owners follow the rules',async()=>{
 const dir=await tmp();
 try{
  const id=await saveResume({},dir);
  await writeFile(path.join(dir,`${id}.claim`),JSON.stringify({pid:process.pid,createdAt:Date.now()-CLAIM_TTL_MS-1000}));
  const old=new Date(Date.now()-CLAIM_TTL_MS-1000); await utimes(path.join(dir,`${id}.claim`),old,old);
  await assert.rejects(claimResume(id,{},'/tmp',dir),/already being used/,'alive pid past TTL is not stolen');
  await pruneRuns(dir);
  assert.ok((await readdir(dir)).includes(`${id}.claim`),'pruneRuns keeps an alive owner\'s claim');
  // unknown owner (empty legacy claim written by the 0.1 server, or garbage): fresh → kept, past TTL → reclaimed
  for (const legacy of ['','garbage']) {
   const id2=await saveResume({},dir);
   await writeFile(path.join(dir,`${id2}.claim`),legacy);
   await assert.rejects(claimResume(id2,{},'/tmp',dir),/already being used/,'fresh unknown-owner claim is not stolen');
   await utimes(path.join(dir,`${id2}.claim`),old,old);
   const r2=await claimResume(id2,{},'/tmp',dir);
   assert.equal(JSON.parse(await readFile(path.join(dir,`${id2}.claim`),'utf8')).pid,process.pid);
   await r2();
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('F2: concurrent reclaimers of one abandoned claim produce exactly one winner',async()=>{
 const dir=await tmp();
 try{
  for (let round=0; round<10; round++) {
   const id=await saveResume({},dir);
   await writeFile(path.join(dir,`${id}.claim`),JSON.stringify({pid:DEAD_PID,createdAt:Date.now()}));
   const results=await Promise.allSettled(Array.from({length:6},()=>claimResume(id,{},'/tmp',dir)));
   const winners=results.filter(r=>r.status==='fulfilled');
   assert.equal(winners.length,1,`round ${round}: exactly one winner`);
   for (const r of results) if (r.status==='rejected') assert.match(String(r.reason),/already being used/);
   assert.ok(!(await readdir(dir)).some(n=>n.includes('.tomb')),'tombstones are cleaned up');
   await winners[0].value();
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('F5 support: a settled claim is never treated as abandoned',async()=>{
 const dir=await tmp();
 try{
  const id=await saveResume({},dir);
  await writeFile(path.join(dir,`${id}.claim`),JSON.stringify({pid:DEAD_PID,createdAt:Date.now()-CLAIM_TTL_MS-1000,settled:true}));
  await assert.rejects(claimResume(id,{},'/tmp',dir),/already being used|already used/);
  await pruneRuns(dir);
  assert.ok((await readdir(dir)).includes(`${id}.claim`));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('saveResume prunes resume records older than 14 days and dead-owner claims, best effort',async()=>{
 const dir=await tmp();
 try{
  const oldId=await saveResume({old:true},dir); const keepId=await saveResume({keep:true},dir);
  const old=new Date(Date.now()-15*24*3600e3); await utimes(path.join(dir,`${oldId}.json`),old,old);
  await writeFile(path.join(dir,`${keepId}.claim`),JSON.stringify({pid:DEAD_PID,createdAt:Date.now()}));
  await writeFile(path.join(dir,'unrelated.txt'),'x'); await utimes(path.join(dir,'unrelated.txt'),old,old);
  const fresh=await saveResume({fresh:true},dir);
  const names=(await readdir(dir)).sort();
  assert.ok(!names.includes(`${oldId}.json`),'expired record pruned');
  assert.ok(names.includes(`${keepId}.json`) && names.includes(`${fresh}.json`));
  assert.ok(!names.includes(`${keepId}.claim`),'dead-owner claim pruned');
  assert.ok(names.includes('unrelated.txt'),'only owned file shapes are touched');
  assert.deepEqual(await loadResume(keepId,dir),{keep:true});
  await pruneRuns(path.join(dir,'missing'));  // never throws
 }finally{await rm(dir,{recursive:true,force:true});}
});
const DAY=24*3600e3;
const ago=ms=>new Date(Date.now()-ms);
test('R2-2a: a settled-marker claim whose record is gone is removed once older than the record max age',async()=>{
 const dir=await tmp();
 try{
  const {RUN_RECORD_MAX_AGE_MS}=await import('../lib/recipes.mjs');
  const oldId='11111111-1111-4111-8111-111111111111', youngId='22222222-2222-4222-8222-222222222222', keptId=await saveResume({},dir);
  for (const id of [oldId,youngId,keptId]) await writeFile(path.join(dir,`${id}.claim`),JSON.stringify({pid:process.pid,createdAt:Date.now(),settled:true}));
  const old=ago(RUN_RECORD_MAX_AGE_MS+DAY);
  await utimes(path.join(dir,`${oldId}.claim`),old,old);
  await writeFile(path.join(dir,`${oldId}.claim`),JSON.stringify({pid:process.pid,createdAt:old.getTime(),settled:true})); await utimes(path.join(dir,`${oldId}.claim`),old,old);
  await pruneRuns(dir);
  const names=await readdir(dir);
  assert.ok(!names.includes(`${oldId}.claim`),'orphan settled marker past max age removed');
  assert.ok(names.includes(`${youngId}.claim`),'young orphan settled marker kept');
  assert.ok(names.includes(`${keptId}.claim`),'settled marker with a live record kept');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('R2-2b: stale atomicWrite *.tmp leftovers are removed after the claim TTL; fresh ones and foreign files are kept',async()=>{
 const dir=await tmp();
 try{
  const id=await saveResume({},dir);
  const stale=`${id}.json.${DEAD_PID}.33333333-3333-4333-8333-333333333333.tmp`, fresh=`${id}.json.${process.pid}.44444444-4444-4444-8444-444444444444.tmp`;
  for (const n of [stale,fresh,'foreign.tmp']) await writeFile(path.join(dir,n),'{}');
  const old=ago(CLAIM_TTL_MS+60e3);
  for (const n of [stale,'foreign.tmp']) await utimes(path.join(dir,n),old,old);
  await pruneRuns(dir);
  const names=await readdir(dir);
  assert.ok(!names.includes(stale),'stale tmp removed');
  assert.ok(names.includes(fresh),'fresh tmp kept (a write may be in flight)');
  assert.ok(names.includes('foreign.tmp'),'files not shaped like atomicWrite output are untouched');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('R2-2c: pruneRuns caps pid claims at 7 days only when the record is expired or missing; claimResume never applies the cap',async()=>{
 const dir=await tmp();
 try{
  const {RUN_RECORD_MAX_AGE_MS,CLAIM_ABSOLUTE_CAP_MS}=await import('../lib/recipes.mjs');
  assert.equal(CLAIM_ABSOLUTE_CAP_MS,7*DAY);
  const writeClaim=async(id,age)=>{ const t=ago(age); const f=path.join(dir,`${id}.claim`); await writeFile(f,JSON.stringify({pid:process.pid,createdAt:t.getTime()})); await utimes(f,t,t); };
  // live run, fresh record, claim 8 days old: kept by prune AND not robbed by claimResume
  const live=await saveResume({},dir); await writeClaim(live,8*DAY);
  // expired record + alive-pid claim 8 days old (pid reuse): both removed
  const reused=await saveResume({},dir); await writeClaim(reused,8*DAY);
  const exp=ago(RUN_RECORD_MAX_AGE_MS+DAY); await utimes(path.join(dir,`${reused}.json`),exp,exp);
  // missing record + alive-pid claim 8 days old: removed
  const orphan='55555555-5555-4555-8555-555555555555'; await writeClaim(orphan,8*DAY);
  // expired record + alive-pid claim only 2 days old: kept (under the cap)
  const young=await saveResume({},dir); await writeClaim(young,2*DAY); await utimes(path.join(dir,`${young}.json`),exp,exp);
  await pruneRuns(dir);
  const names=await readdir(dir);
  assert.ok(names.includes(`${live}.claim`) && names.includes(`${live}.json`),'live run with a fresh record is never pruned');
  assert.ok(!names.includes(`${reused}.claim`) && !names.includes(`${reused}.json`),'capped claim + expired record pruned');
  assert.ok(!names.includes(`${orphan}.claim`),'capped orphan claim pruned');
  assert.ok(names.includes(`${young}.claim`) && names.includes(`${young}.json`),'claim under the cap protects its record');
  await assert.rejects(claimResume(live,{},'/tmp',dir),/already being used/,'claimResume never applies the 7-day cap to a live pid');
 }finally{await rm(dir,{recursive:true,force:true});}
});
