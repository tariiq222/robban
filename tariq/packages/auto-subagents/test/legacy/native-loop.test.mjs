import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtimeModuleUrl } from '../../lib/dsh-paths.mjs';
import * as Routing from '../../lib/runtime.mjs';
const { Context } = await import(runtimeModuleUrl('@deepseek-ai/cordis'));
const { default: Llm, LlmAdapter, createUserMessage } = await import(runtimeModuleUrl('@deepseek-ai/dsh-llm'));
const services = await Promise.all(['session','session-projection','system-prompt','tools','agent','agent-loop'].map(async name => (await import(runtimeModuleUrl(`@deepseek-ai/dsh-${name}`))).default));
for (const failure of [
  { code:'QUOTA', message:'quota exhausted' },
  { code:'PI_AI_ERROR', message:'404: ' + JSON.stringify({message:'Model "missing" does not exist.',type:'not_found_error',code:'not_found'}) },
]) test(`native loop settles ${failure.code}, retries the same child and admits the task once`, async () => {
  const ctx = new Context();
  const seen = [];
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return {provider,id:model,name:model}; }
    async *stream(request) {
      seen.push(request);
      if (request.model === 'a') {
        yield {type:'block-start',index:0,blockType:'tool-call'};
        yield {type:'tool-call-delta',index:0,id:'partial-call',name:'write',argumentsDelta:'{"path":'};
        yield {type:'finish',reason:{kind:'error',failure}};
      } else {
        yield {type:'block-start',index:0,blockType:'text'};
        yield {type:'text-delta',index:0,text:'Finished without replay'};
        yield {type:'block-end',index:0,block:{type:'text',text:'Finished without replay'}};
        yield {type:'finish',reason:{kind:'stop'}};
      }
    }
  }
  try {
    await ctx.plugin(Llm);
    for (const service of services) await ctx.plugin(service, service === services.at(-1) ? {agents:[]} : undefined);
    ctx.llm.registerAdapter(['one','two'], new Adapter());
    ctx.provide('subagentModelSelection',{current:()=>({enabled:true,allowedModels:[{provider:'one',model:'a'},{provider:'two',model:'b'}]})});
    ctx.provide('agentPresets',{composedPreset:()=> 'auto-subagents'});
    await ctx.plugin(Routing);
    const handle=await ctx.agentLoop.createAgent(ctx,{sessionId:'same-child',meta:{origin:'subagent'},agentOptions:{provider:'one',model:'a'}});
    const agent=handle.agent;
    const message=createUserMessage({content:[{type:'text',text:'Do this task exactly once'}],source:{kind:'user'}});
    agent.followup(message);
    await agent.whenIdle();
    assert.deepEqual(seen.map(request=>request.model),['a','b']);
    assert.equal(seen[0].sessionId,seen[1].sessionId);
    const events=agent.session.snapshotEvents();
    assert.equal(events.filter(event=>event.type==='user/message' && event.data.id===message.id).length,1);
    assert.equal(events.filter(event=>event.type==='assistant/attempt').length,1);
    assert.equal(events.filter(event=>event.type==='assistant/message').length,1);
    assert.equal(events.filter(event=>event.type==='tool/call'||event.type==='tool/result').length,0);
    assert.equal(agent.session.requestHeader().config.model,'b');
    assert.equal(events.find(event=>event.type==='auto-subagent/route').ignorable,true);
    assert.ok(seen[1].messages.some(message=>message.content.some(block=>block.type==='text'&&block.text.includes('Continue from the existing history'))));
  } finally { await ctx.fiber.dispose(); }
});
