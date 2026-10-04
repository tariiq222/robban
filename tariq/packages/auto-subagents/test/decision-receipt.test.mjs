import {test} from 'node:test';import assert from 'node:assert/strict';
import {verifiedDecisions} from '../lib/decision-receipt.mjs';
const qs=[{id:'q'}];
const call=(ids,callId='c')=>({type:'tool/call',data:{name:'ask_user_question',callId,arguments:{questions:ids.map(id=>({id}))}}});
const result=(answers,callId='c',isError=false)=>({type:'tool/result',data:{message:{role:'tool',source:{kind:'tool',callId},toolCallId:callId,isError,content:[{type:'text',text:JSON.stringify({answers})}]}}});
const ans=(id,custom)=>({id,selected:[],custom});
test('only successful scoped human question responses authorize resume',()=>{
 assert.deepEqual(verifiedDecisions([call(['run:q']),result([ans('run:q','yes')])],'run',qs),{q:'yes'});
 assert.throws(()=>verifiedDecisions([],'run',qs),/No verified/);
 assert.throws(()=>verifiedDecisions([result([ans('run:q','yes')])],'run',qs),/No verified/,'result without a matching call');
 assert.throws(()=>verifiedDecisions([call(['run:q']),result([ans('run:q','yes')],'c',true)],'run',qs),/No verified/,'error result');
 assert.throws(()=>verifiedDecisions([call(['run:q']),result([ans('run:q','yes')])],'other',qs),/No verified/,'other run');
});
test('decidedForYou overrides are accepted only as verified answers to optional ids, never required',()=>{
 const events=[call(['run:q','run:d1']),result([ans('run:q','yes'),ans('run:d1','use B')])];
 assert.deepEqual(verifiedDecisions(events,'run',qs,['d1','d2']),{q:'yes',d1:'use B'});
 // optional ids alone never satisfy required questions
 assert.throws(()=>verifiedDecisions([call(['run:d1']),result([ans('run:d1','x')])],'run',qs,['d1']),/No verified/);
 // an id not recorded as overridable is foreign: the whole batch is not a receipt
 assert.throws(()=>verifiedDecisions([call(['run:q','run:zz']),result([ans('run:q','yes'),ans('run:zz','x')])],'run',qs,['d1']),/No verified/);
});
test('answers split across two batches count when each batch asks only this run\'s wanted ids; later answer wins',()=>{
 const two=[{id:'a'},{id:'b'}];
 const events=[call(['run:a'],'c1'),result([ans('run:a','first')],'c1'),call(['run:b','run:a'],'c2'),result([ans('run:b','B'),ans('run:a','second')],'c2')];
 assert.deepEqual(verifiedDecisions(events,'run',two),{a:'second',b:'B'});
 // a batch that mixes an unrelated id is not a receipt for this run
 const mixed=[call(['run:a'],'c1'),result([ans('run:a','A')],'c1'),call(['run:b','other:x'],'c2'),result([ans('run:b','B')],'c2')];
 assert.throws(()=>verifiedDecisions(mixed,'run',two),/decision "b"/);
});
