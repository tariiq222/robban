import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerWorkflowRouting } from '../lib/workflow-routing.mjs';
import { AutoModelRouter } from '../lib/router.mjs';
import { runtimeModuleUrl } from '../lib/dsh-paths.mjs';
const { Context } = await import(runtimeModuleUrl('@deepseek-ai/cordis'));
const { default: ToolRuntime, defineTool } = await import(runtimeModuleUrl('@deepseek-ai/dsh-tools'));
const { default: SystemPrompt } = await import(runtimeModuleUrl('@deepseek-ai/dsh-system-prompt'));
const { createScope } = await import(runtimeModuleUrl('@deepseek-ai/dsh-scope'));
const { applyChildComposition } = await import(runtimeModuleUrl('@deepseek-ai/dsh-subagent'));
const allowed = ['read', 'read_image', 'glob', 'grep'];
const childTools = [...allowed, 'structured_output']; // the driver attaches the result tool after filtering
function fixture() {
  const providers = new Map(), starts = [], pending = [];
  providers.set('spawn', { name: 'spawn', inheritsParentContext: false, capabilities: { agentOptions: true, outputSchema: true, toolFilter: true }, async start(request) {
    starts.push(request); let resolve; const result = new Promise(r => { resolve = r; }); pending.push(resolve);
    return { id: `child-${starts.length}`, result, dispose: async () => resolve({ stopReason: 'aborted' }) };
  } });
  const subagents = { getProvider: n => providers.get(n), registerProvider(p) { providers.set(p.name,p); return () => providers.delete(p.name); } };
  const parent = { id: 'parent', session: { header: { id: 'parent' } } };
  const settings = { enabled: true, allowedModels: ['A','B'].map(model => ({provider:'p',model})), modelTiers: ['A','B'].map(model => ({provider:'p',model,tier:'strong'})) };
  const router = new AutoModelRouter({current:()=>settings}, {listProviders:()=>[{id:'p'}],resolveCallConfig:async c=>c});
  const routing = registerWorkflowRouting({subagents,router,parent,recipeRoles:{'audit-scanner':{tier:'strong',readOnlyRetry:true}}});
  const start = (readOnly=true, extra={}) => providers.get(routing.providerName).start({parent,signal:new AbortController().signal,prompt:[{type:'text',text:'__AUTO_RECIPE_ROLE__'+JSON.stringify({token:routing.markerToken,role:'audit-scanner',label:'analysis',readOnly})+'\nInspect'}],outputSchema:{type:'object'},...extra});
  return {routing,start,starts,pending,router};
}
test('readOnly marker enforces host-owned allowlist before spawn and on replacement',async t=>{
  const f=fixture(); t.after(()=>f.routing.dispose()); const run=await f.start();
  assert.deepEqual(f.starts[0].toolFilter,{allow:allowed});
  f.pending[0]({stopReason:'completed'}); await new Promise(r=>setImmediate(r));
  assert.equal(f.starts.length,2); assert.deepEqual(f.starts[1].toolFilter,{allow:allowed});
  f.pending[1]({stopReason:'completed',structured:{}}); await run.result;
  assert.equal(f.router.activeCounts.size,0);
});
test('readonly intersects caller restrictions and cannot grant bash through marker fields',async t=>{
  const f=fixture();t.after(()=>f.routing.dispose());const run=await f.start(true,{toolFilter:{allow:['read','bash'],deny:['read']}});
  assert.deepEqual(f.starts[0].toolFilter,{allow:['read'],deny:['read']});await run.dispose();
});
test('unmarked existing steps preserve filters, invalid readOnly type fails before admission',async t=>{
  const f=fixture();t.after(()=>f.routing.dispose());const run=await f.start(false,{toolFilter:{allow:['bash']}});assert.deepEqual(f.starts[0].toolFilter,{allow:['bash']});await run.dispose();
  await assert.rejects(f.start('true'),/readOnly/);assert.equal(f.starts.length,1);
});
test('readonly rejects malformed filters before admission',async t=>{
 const f=fixture();t.after(()=>f.routing.dispose());
 for(const toolFilter of [{allow:'read'},{deny:[1]},{unknown:true},null])await assert.rejects(f.start(true,{toolFilter}),/tool filter/);
 assert.equal(f.starts.length,0);
});
test('readonly never rewrites the persisted descriptor (installed one-shot schema forbids toolFilter)',async t=>{
 const f=fixture();t.after(()=>f.routing.dispose());const run=await f.start(true,{descriptor:{mode:'one-shot',provider:'test',toolFilter:{allow:['bash']}}});
 assert.deepEqual(f.starts[0].toolFilter,{allow:allowed});assert.deepEqual(f.starts[0].descriptor,{mode:'one-shot',provider:'test',toolFilter:{allow:['bash']}},'descriptor passed through unmodified; the filter travels on the request');await run.dispose();
});
test('actual child composition enforces readonly tool registry including nested and late tools',async t=>{
  const f=fixture();t.after(()=>f.routing.dispose());const holder=await f.start();const filter=f.starts[0].toolFilter;
  const root=new Context();root.plugin(SystemPrompt);root.plugin(ToolRuntime);await new Promise(r=>setTimeout(r,10));
  let env, setupError;root.plugin({inject:['tools','systemPrompt'],apply(ctx){ try {
    const parentKey={id:'parent'},parentScope=createScope(ctx,parentKey);const childKey={id:'child'},childScope=createScope(ctx,childKey,{parent:parentKey});
    for(const name of [...allowed,'write','edit','bash','subagent','ego_click'])parentScope.ctx.tools.register(defineTool({name,description:name,parameters:{},output:{schema:{type:'string'},render:()=>[]},execute:async()=>name}));
    applyChildComposition({get:()=>undefined,tools:childScope.ctx.tools,systemPrompt:{context(){},getContextOrder:()=>0}},{key:parentKey,ctx:parentScope.ctx},{toolFilter:filter});env={ctx,parentScope,childKey};
  } catch(error) {setupError=error;} }});await new Promise(r=>setTimeout(r,10));
  if(setupError) throw setupError; assert.ok(env,'tool runtime harness initialized');
  for(const name of ['write','edit','bash','subagent','ego_click','run_code']){const result=await env.ctx.tools.execute({callId:name,name,arguments:{},agent:env.childKey,parent:{token:1},signal:new AbortController().signal});assert.equal(result.isError,true,name);}
  assert.deepEqual(env.ctx.tools.schemas(env.childKey).map(x=>x.name).sort(),[...allowed].sort());
  env.parentScope.ctx.tools.register(defineTool({name:'future-write',description:'x',parameters:{},output:{schema:{type:'string'},render:()=>[]},execute:async()=>''}));
  assert.ok(!env.ctx.tools.schemas(env.childKey).some(x=>x.name==='future-write'));await holder.dispose();
});
