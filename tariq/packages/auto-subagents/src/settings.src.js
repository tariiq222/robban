// Staged Auto settings use the Host's revision-fenced config form.
var SETTINGS_NS = 'auto-subagents.settings';
var settingsEn = { title:'Auto Subagents', direction:'ltr', description:'Choose allowed models and routing tiers for Auto delegation.', enabled:'Enable automatic routing', provider:'Provider', model:'Model', tier:'Tier', strong:'Strong', medium:'Medium', light:'Light', add:'Add model', remove:'Remove', save:'Save changes', discard:'Discard changes', models:'Allowed models', routingHint:'Auto selects from these models for each task.', saved:'Changes apply after saving.', conflict:'Settings changed elsewhere. Discard this draft and try again.', failed:'Could not save settings.', unavailable:'Model catalog unavailable. Saved routes are still editable.', refresh:'Refresh models', empty:'Add at least one model to enable routing.' };
function AutoSettings(props) {
  var snapshot = props.useAutoSettings(function (value) { return value; });
  var pair = useState(null), draft = pair[0], setDraft = pair[1];
  var busyPair = useState(false), busy = busyPair[0], setBusy = busyPair[1];
  var errorPair = useState(null), error = errorPair[0], setError = errorPair[1];
  var catalogPair = useState([]), catalog = catalogPair[0], setCatalog = catalogPair[1];
  var catalogErrorPair = useState(false), catalogError = catalogErrorPair[0], setCatalogError = catalogErrorPair[1];
  var revisionPair = useState(0), catalogRevision = revisionPair[0], refreshCatalog = revisionPair[1];
  React.useEffect(function () {
    var active = true;
    props.catalog().then(function (result) {
      if (!active) return;
      setCatalogError(!result.ok || result.value.failures.length > 0);
      if (result.ok) setCatalog(result.value.groups.flatMap(function (group) { return group.models.map(function (model) { return {provider:group.id,model:model.id}; }); }));
    }).catch(function () { if (active) setCatalogError(true); });
    return function () { active = false; };
  }, [props.catalog, catalogRevision]);
  if (props.view === 'summary') return props.t('description');
  if (snapshot.status !== 'ready' || !snapshot.value) return null;
  var value = draft ? draft.value : snapshot.value;
  var t = props.t;
  var conflicted = draft && draft.revision !== snapshot.revision;
  var invalid = value.enabled && value.allowedModels.length === 0;
  function change(next) { setError(null); setDraft({revision:draft ? draft.revision : snapshot.revision,value:next}); }
  function remove(index) {
    var route = value.allowedModels[index];
    change(Object.assign({}, value, {allowedModels:value.allowedModels.filter(function (_,i) {return i!==index;}),modelTiers:value.modelTiers.filter(function (tier) {return tier.provider!==route.provider || tier.model!==route.model;})}));
  }
  function setTier(route, tier) {
    change(Object.assign({},value,{modelTiers:value.modelTiers.filter(function (item) {return item.provider!==route.provider || item.model!==route.model;}).concat([Object.assign({},route,{tier:tier})])}));
  }
  async function save() {
    if (!draft || conflicted || invalid || busy || !snapshot.writable) return;
    setBusy(true); setError(null);
    try { if (await props.save(draft.value,draft.revision)) setDraft(null); else setError('failed'); }
    catch (_) { setError('failed'); }
    finally { setBusy(false); }
  }
  var candidates = catalog.filter(function (route) {return !value.allowedModels.some(function (saved) {return saved.provider===route.provider && saved.model===route.model;});});
  return h('section', {className:'ars-settings',dir:t('direction')},
    h('fieldset',{disabled:busy || !snapshot.writable},
      h('label',{className:'ars-settings-toggle'},h('span',null,h('strong',null,t('enabled')),h('small',null,t('routingHint'))),h('input',{type:'checkbox',role:'switch','aria-label':t('enabled'),checked:value.enabled,onChange:function (event) {change(Object.assign({},value,{enabled:event.target.checked}));}})),
      h('div',{className:'ars-settings-section-title'},h('h2',null,t('models')),h('span',{className:'ars-settings-count'},value.allowedModels.length)),
      value.allowedModels.map(function (route,index) {
        var tier=value.modelTiers.find(function (item) {return item.provider===route.provider && item.model===route.model;});
        return h('div',{key:route.provider+'\0'+route.model,className:'ars-settings-route'},
          h('div',{className:'ars-settings-identity',dir:'ltr'},h('strong',null,route.model),h('span',null,route.provider)),
          h('label',null,t('tier'),h('select',{'aria-label':t('tier')+' '+route.model,value:tier?tier.tier:'medium',onChange:function (event) {setTier(route,event.target.value);}},['strong','medium','light'].map(function (item) {return h('option',{key:item,value:item},t(item));}))),
          h('button',{type:'button',className:'ars-settings-remove',onClick:function () {remove(index);},'aria-label':t('remove')+' '+route.model},t('remove')));
      }),
      h('div',{className:'ars-settings-add'},h('label',null,h('span',null,t('add')),h('select',{value:'',onChange:function (event) {
        if (event.target.value==='') return;
        var route=candidates[Number(event.target.value)];
        if (route) change(Object.assign({},value,{allowedModels:value.allowedModels.concat([route]),modelTiers:value.modelTiers.concat([Object.assign({},route,{tier:'medium'})])}));
      }},h('option',{value:''},t('add')),candidates.map(function (route,index) {return h('option',{key:route.provider+'\0'+route.model,value:String(index)},route.provider+' / '+route.model);}))),
      h('button',{type:'button',onClick:function () {refreshCatalog(catalogRevision+1);}},t('refresh'))),
      catalogError ? h('p',{role:'status'},t('unavailable')) : null,
      invalid ? h('p',{role:'alert'},t('empty')) : null,
      conflicted ? h('p',{role:'alert'},t('conflict')) : null,
      error ? h('p',{role:'alert'},t(error)) : null,
      h('footer',{className:'ars-settings-actions'},h('span',null,t('saved')),h('div',null,h('button',{type:'button',className:'ars-settings-save',disabled:!draft||conflicted||invalid,onClick:save},t('save')),
      h('button',{type:'button',disabled:!draft,onClick:function () {setDraft(null);setError(null);}},t('discard'))))));
}
function registerAutoSettings(ctx) {
  ctx.effect(function () { return ctx.locale.register(SETTINGS_NS,{en:settingsEn,ar:settingsEn,zh:settingsEn}); }, 'auto-subagents: settings locale');
  var form=ctx.configForms.get('auto-model-selection');
  var face={hooks:{autoSettings:form},catalog:function () {return ctx.remote.session.modelCatalog();},save:function (value,revision) {return form.mutate(['enabled','allowedModels','modelTiers'].map(function (field) {return {op:'set',path:[field],value:value[field]};}),revision);}};
  ctx.effect(function () {return ctx.configForms.whileServed(['auto-model-selection'],function () {return ctx.slots.inject('plugins.bundle.config',function () {return ctx.slots.register({name:'plugins.bundle.config',key:'dsh-auto-subagents',locale:SETTINGS_NS,inject:function () {return face;}},AutoSettings);});});},'auto-subagents: settings page');
}
