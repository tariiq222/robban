// Saved bug-fix recipe: plain AsyncFunction body; no imports or host mutations.
const task = typeof args?.task === 'string' ? args.task.trim() : '';
const repo = typeof args?.repo === 'string' ? args.repo.trim() : '';
if (!task || !repo || !repo.startsWith('/')) throw new Error('task and absolute repo are required');
const text = v => typeof v === 'string' && v.trim().length > 0;
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const strings = { type: 'array', items: { type: 'string' } };
const S = { type: 'string' }, B = { type: 'boolean' };
const commandSchema = object({command:S,exitCode:{type:'number'},evidence:S,passed:B});
const commandsSchema = {type:'array',items:commandSchema};
const redSchema = object({...commandSchema.properties,failureKind:{type:'string',enum:['assertion','behavior','setup','syntax','dependency','unknown']},testExecuted:B});
const decisionSchema = object({id:S,question:S,current:S,options:{type:'array',items:object({label:S,consequence:S})},recommendation:S,why:S});
const decisionsSchema = {type:'array',items:decisionSchema};
const scopeSchema = object({files:strings,tests:strings,symbols:strings,dependents:strings});
const setupSchema = object({stack:S,verifyCommands:strings,conventions:strings});
const analysisSchema = object({scope:scopeSchema,outcome:{type:'string',enum:['reproducible','not_reproducible']},reason:S,currentState:S,expectedBehavior:S,acceptance:strings,decisions:decisionsSchema});
const findingSchema = object({id:S,severity:{type:'string',enum:['low','medium','high','blocker']},problem:S,requiredFix:S});
const implSchema = object({changedPaths:strings,commands:commandsSchema,regression:object({red:redSchema,green:commandSchema,beforeProduction:B}),notes:S,decisions:decisionsSchema});
const reviewSchema = object({verdict:{type:'string',enum:['APPROVED','NEEDS_REVISION']},summary:S,findings:{type:'array',items:findingSchema}});
const validationSchema = object({results:{type:'array',items:object({criterion:S,status:{type:'string',enum:['passed','failed']},evidence:S})},commands:commandsSchema,summary:S});
const common = `Repository: ${repo}\nRequest: ${task}\nWork only inside this repository. Preserve unrelated dirty work. No commit, push, merge, deployment, installs, secrets or destructive cleanup. Only execute existing repository-local verification commands after reading their scripts; do not execute untrusted network installers or destructive commands. Never fabricate a command or evidence. End with structured_output. Read-only reviewers/validator may run safe verification but may NOT edit files.`;
const invoke = async (label,role,prompt,schema,readOnly=false) => {
  const phaseName = ['analysis','validate'].includes(role) ? role : 'code-loop';
  const timeoutMs = role === 'implementer' ? 1200000 : role === 'setup' ? 180000 : 480000;
  const marker = args.routingToken ? '__AUTO_RECIPE_ROLE__'+JSON.stringify({token:args.routingToken,role,label,timeoutMs,readOnly})+'\n' : '';
  try { return await agent(marker+common+'\n\n'+prompt,{label,phase:phaseName,schema}); } catch { return null; }
};
const concrete = p => text(p) && !p.startsWith('/') && !/[\\:*?\[\]{}\x00-\x1f]/.test(p) && p.split('/').every(part=>part && part!=='.' && part!=='..');
const uniqueText = list => Array.isArray(list) && list.length > 0 && list.every(text) && new Set(list).size===list.length;
const validCommand = c => c && text(c.command) && Number.isInteger(c.exitCode) && text(c.evidence) && typeof c.passed==='boolean';
const pass = c => validCommand(c) && c.exitCode===0 && c.passed===true;
const verify = (list,expected) => Array.isArray(list) && list.every(pass) && expected.every(command=>list.filter(c=>c.command===command).length===1);
let changedPaths = Array.isArray(args.resume?.changedPaths) ? [...args.resume.changedPaths] : [];
let commands = Array.isArray(args.resume?.commands) ? [...args.resume.commands] : [];
let reviewTrail = Array.isArray(args.resume?.reviewTrail) ? [...args.resume.reviewTrail] : [];
let findings = Array.isArray(args.resume?.lastFindings) ? [...args.resume.lastFindings] : [], validation = null;
let attemptCount = args.resume?.attemptCount ?? 0;
if (!Number.isInteger(attemptCount) || attemptCount<0 || attemptCount>3) throw new Error('resume attempt budget invalid');
let firstRegression = args.resume?.regression ?? null;
const regressionValid = r => r && r.beforeProduction===true && validCommand(r.red) && r.red.exitCode>0 && r.red.passed===false && r.red.testExecuted===true && ['assertion','behavior'].includes(r.red.failureKind) && pass(r.green) && r.green.command===r.red.command;
const base = () => ({changedPaths:[...changedPaths],commands:[...commands],reviewTrail:[...reviewTrail],findings:[...findings],validation,confirmedDecisions:{...answers}});
const stop = (status,reason,extra={}) => ({status,reason,...base(),...extra});
const resume = args.resume;
if (resume && (resume.task!==task || resume.repo!==repo || !resume.setup || !resume.analysis || !Number.isInteger(resume.round) || resume.round<1)) throw new Error('resume does not match task/repo or saved state');
const answers = {...(resume?.confirmedDecisions||{}),...(args.decisions||{})};
const answered = d => Object.hasOwn(answers,d.id) && text(answers[d.id]) && d.options.some(o=>o.label===answers[d.id]);
let setup = resume?.setup;
let analysis = resume?.analysis;
if (!analysis) {
 phase('analysis');
 const diagnosis = await invoke('analysis','analysis',`READ ONLY: inspect manifests/config and exact existing local verification command definitions, stack and conventions. Never guess commands. Also provide narrow source diagnosis of this defect, direct callers and covering tests. No bash/command execution or edits. Distinguish observed/current from intended behavior with file:line evidence. outcome reproducible means a concrete source-confirmed issue with a feasible regression, NOT a claimed runtime reproduction. Treat this outcome only as a source candidate until the implementer records qualifying RED evidence; source inspection alone never proves runtime reproduction. If no concrete issue, not_reproducible. Scope.files must enumerate literal concrete files permitted to change (include the intended regression test file even if new); do not list directories, globs or reference-only files. Include scope.tests/symbols/dependents. Exact unique acceptance includes regression and existing behavior. Raise stable kebab-case decision ids for security/permissions, deletion or API/visible behavior changes rather than guessing.`,object({setup:setupSchema,analysis:analysisSchema}),true);
 setup = diagnosis?.setup;
 analysis = diagnosis?.analysis;
}
if (!setup || !uniqueText(setup.verifyCommands)) return stop('aborted','No structured setup or existing verification commands');
if (!analysis || !analysis.scope || !uniqueText(analysis.scope.files) || !analysis.scope.files.every(concrete) || !uniqueText(analysis.scope.tests) || !analysis.scope.tests.every(p=>concrete(p)&&analysis.scope.files.includes(p)) || !uniqueText(analysis.acceptance)) return stop('aborted','Invalid or missing narrow diagnosis/scope/acceptance');
const pending = list => (list||[]).filter(d=>!answered(d));
const decisionStop = (list,stage) => {
 const saved = {task,repo,round:(resume?.round||0)+1,setup,analysis,confirmedDecisions:answers,changedPaths:[...changedPaths],commands:[...commands],regression:firstRegression,attemptCount,reviewTrail:[...reviewTrail],lastFindings:[...findings],pendingDecisions:list};
 return stop('needs_decision','Human decision required',{stage,questions:pending(list),decidedForYou:[],resume:saved});
};
if (resume?.pendingDecisions && pending(resume.pendingDecisions).length) throw new Error('resume requires complete verified decision answers');
if (pending(analysis.decisions).length) {
 if (resume) throw new Error('resume missing original decision answer');
 return decisionStop(analysis.decisions,'analysis');
}
if (analysis.outcome!=='reproducible') return stop('ended',analysis.reason || 'No reproducible defect established; nothing repaired');
const scope = new Set(analysis.scope.files);
if (changedPaths.some(p=>!concrete(p)||!scope.has(p))) throw new Error('resume changedPaths outside diagnosis scope');
const acceptance = analysis.acceptance;
const contract = `Diagnosis and binding decisions: ${JSON.stringify(analysis)}\nConfirmed answers: ${JSON.stringify(answers)}\nAllowed changed paths EXACTLY: ${JSON.stringify([...scope])}\nRun every verification command: ${JSON.stringify(setup.verifyCommands)}`;
if (firstRegression && !regressionValid(firstRegression)) throw new Error('resume regression evidence invalid');
// Durable checkpoint for run_recipe: a later error/timeout/cancel can resume from the last finished state.
const savedState = (attempts=attemptCount) => ({task,repo,round:(resume?.round||0)+1,setup,analysis,confirmedDecisions:{...answers},changedPaths:[...changedPaths],commands:[...commands],regression:firstRegression,attemptCount:attempts,reviewTrail:[...reviewTrail],lastFindings:[...findings]});
const checkpoint = (attempts=attemptCount) => log('@@auto-recipe '+JSON.stringify({kind:'checkpoint',state:savedState(attempts)}));
checkpoint();
phase('code-loop');
for (let iteration=attemptCount+1;iteration<=3;iteration++) {
 attemptCount=iteration;
 const impl = await invoke(`implement #${iteration}`,'implementer',`${contract}\n${!firstRegression ? 'Write a regression test first; run it and record a genuine failing assertion (RED) BEFORE editing production. A compile/setup/dependency failure is not reproduction. If RED cannot be achieved, do not change production; report actual partial changes and unsuccessful evidence. Then minimal fix, rerun EXACT same regression command GREEN and every verify command. Report red/green exitCode, evidence and beforeProduction boolean; red.testExecuted must prove the regression actually ran; red.failureKind assertion/behavior only qualifies (setup/syntax/dependency/unknown never count).' : `Repair EVERY finding below without widening scope, then rerun regression GREEN and every verify. Retain the original RED evidence, never relabel a green baseline as RED. Findings: ${JSON.stringify(findings)}\nOriginal regression: ${JSON.stringify(firstRegression)}`}\nReport all actually changed paths, even partial/out-of-scope changes. Stop for new security/deletion/API choices and report decisions without implementing them.`,implSchema);
 if (!impl) return stop('aborted','Implementer returned no structured result');
 for (const p of impl.changedPaths||[]) if (!changedPaths.includes(p)) changedPaths.push(p);
 commands.push(...(impl.commands||[]));
 if (!Array.isArray(impl.changedPaths) || impl.changedPaths.some(p=>!concrete(p)||!scope.has(p))) return stop('aborted','Changed paths outside literal diagnosis scope');
 if (!firstRegression && regressionValid(impl.regression)) firstRegression=impl.regression;
 if (pending(impl.decisions).length) return decisionStop(impl.decisions,'implement');
 const regression=impl.regression;
 if (!regressionValid(regression) || !verify(impl.commands,setup.verifyCommands)) return stop('aborted','Missing genuine RED-before-production, same-command GREEN, or full verification');
 if (firstRegression && JSON.stringify(regression.red)!==JSON.stringify(firstRegression.red)) return stop('aborted','Original RED evidence changed across repair iterations');
 if (!firstRegression) firstRegression=regression;
 const reviews = await parallel([1,2].map(n=>()=>invoke(`review-${n} #${iteration}`,'reviewer',`${contract}\nIndependent reviewer ${n}: inspect actual current files, all accumulated changed paths ${JSON.stringify(changedPaths)}, and direct dependents. Do NOT trust the author. Rerun ${regression.green.command} and all verify commands. Check actual RED evidence before production: verify the command really executed the regression and the failing assertion/observed expected-vs-actual matches this diagnosed defect, not syntax/setup/dependency failures. Check no scope escapes, regression specificity and every acceptance criterion. Any failing verification, stale evidence or acceptance violation must be high/blocker and NEEDS_REVISION. No edits.\nImplementation: ${JSON.stringify(impl)}`,reviewSchema)));
 findings=[];
 const ranks={low:0,medium:1,high:2,blocker:3};
 for (let n=0;n<2;n++) {
  const r=reviews[n];
  const report = r || {verdict:'NEEDS_REVISION',summary:'Reviewer failed',findings:[{id:`missing-review-${n+1}`,severity:'blocker',problem:`Reviewer ${n+1} did not report`,requiredFix:'Obtain both independent reviews'}]};
  for (const f of report.findings||[]) {
   const old=findings.find(x=>x.id===f.id && x.problem===f.problem && x.requiredFix===f.requiredFix);
   if (!old) findings.push({...f}); else if(ranks[f.severity]>ranks[old.severity]) old.severity=f.severity;
  }
  if (report.verdict!=='APPROVED' && !report.findings.length) findings.push({id:`reject-review-${n+1}`,severity:'high',problem:report.summary || 'Reviewer rejected without findings',requiredFix:'Resolve reviewer rejection with concrete evidence'});
 }
 const approved=reviews.length===2 && reviews.every(r=>r && r.verdict==='APPROVED') && !findings.some(f=>['high','blocker'].includes(f.severity));
 reviewTrail.push({iteration,verdict:approved?'APPROVED':'NEEDS_REVISION',reviews,findings:[...findings]});
 log('@@auto-recipe '+JSON.stringify({label:`aggregate #${iteration}`,verdict:approved?'APPROVED':'NEEDS_REVISION',findings}));
 checkpoint(iteration);
 if (!approved) { if(iteration===3)return stop('aborted','Repair limit reached without both independent approvals; changes remain uncommitted. Continue only if the user agrees: resume gives a fresh repair budget.',{resume:savedState(0)}); continue; }
 phase('validate');
 validation=await invoke('validate','validate',`${contract}\nFresh final validation AFTER the approved iteration. No edits. Rerun regression ${regression.green.command} and ALL verification commands. Report exactly one result for EACH acceptance string unchanged, no duplicates, extra or omitted criteria. Verify cumulative scope and current repository state; no reused earlier validation.`,validationSchema);
 if (validation) commands.push(...validation.commands);
 const results=validation?.results;
 const exact=Array.isArray(results) && results.length===acceptance.length && new Set(results.map(r=>r.criterion)).size===acceptance.length && results.every(r=>acceptance.includes(r.criterion)&&r.status==='passed'&&text(r.evidence));
 const fresh=validation && verify(validation.commands,[...new Set([...setup.verifyCommands,regression.green.command])]);
 return stop(exact&&fresh?'completed':'completed_with_failures',exact&&fresh?'Regression repaired and independently validated':'Final acceptance or fresh verification failed',{regression:firstRegression,passed:`${results?.filter(r=>r.status==='passed').length||0}/${acceptance.length}`});
}
return stop('aborted','Repair limit exhausted');
