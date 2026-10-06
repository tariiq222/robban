// Staged Auto settings use the Host's revision-fenced config form.
var SETTINGS_NS = 'auto-subagents.settings';
var settingsEn = { title:'Auto Subagents', direction:'ltr', description:'Choose allowed models and routing tiers for Auto delegation.', enabled:'Enable automatic routing', provider:'Provider', model:'Model', tier:'Tier', strong:'Build & Review', medium:'Analyze & Plan', light:'Read & Search', strongHint:'Writes code, fixes, reviews and verifies.', mediumHint:'Analysis, planning, requirements and scoping.', lightHint:'File lookup, search, reading and summaries.', moveUp:'Move up', moveDown:'Move down', priority:'Priority {n}', strongAbout:'Your most capable models. They write and fix code, review it, and run final verification and security audits. Implementation, review and validation steps always run here.', mediumAbout:'Capable, cheaper models for thinking work: research, analysis, requirements, design, planning and scoping. With no model here, these tasks move up to Build & Review.', lightAbout:'Your fastest, cheapest models for simple work: finding files, searching, reading and summarizing known files. With no model here, these tasks move up to Analyze & Plan.', tiersNote:'Tasks move up to a stronger tier only when needed, never down.', orderHint:'Within each tier, the model with the lower number is used first when models are equally busy. Reviews prefer a different model than the one that wrote the code.', addTo:'Add a model to {tier}', emptyTier:'No models in this tier yet.', noStrong:'No Build & Review model: implementation and review recipes cannot run.', oneStrong:'Only one Build & Review model: reviews will run on the same model that wrote the code. Add a second model for independent review.', noMedium:'No Analyze & Plan model: analysis tasks will use your Build & Review models, which may cost more.', add:'Add model', remove:'Remove', save:'Save changes', discard:'Discard changes', models:'Allowed models', routingHint:'Auto selects from these models for each task.', saved:'Changes apply after saving.', conflict:'Settings changed elsewhere. Discard this draft and try again.', failed:'Could not save settings.', unavailable:'Model catalog unavailable. Saved routes are still editable.', refresh:'Refresh models', empty:'Add at least one model to enable routing.', recipes:'Recipes', recipesHint:'Approved recipes stay unchanged. These settings are applied when a recipe runs.', recipeEnabled:'Use this recipe', recipeEnabledHint:'When off, the coordinator cannot start this recipe.', options:'Options', flow:'Flow', loopBadge:'Repeats until approved', parallelBadge:'Parallel', stepRole:'Step role', roleHint:'Select a role in the flow to tune it. A role used in several stages changes everywhere.', tierLocked:'Fixed to Build & Review by the recipe contract.', timeout:'Step timeout (minutes)', recipeDefault:'Recipe default', minutes:'{n} min', reset:'Reset', customized:'Customized', timeoutInvalid:'Step timeouts must be whole minutes from 1 to 240.' };
/*@@RECIPE_CATALOG@@*/
var RECIPE_CATALOG = typeof RECIPE_CATALOG_DATA === 'undefined' ? [] : RECIPE_CATALOG_DATA;

// Recipe overrides are a sparse map: an override that matches the recipe default is removed.
function compactEntry(entry) {
  var next = {};
  if (entry.disabled === true) next.disabled = true;
  var roles = {};
  Object.keys(entry.roles || {}).forEach(function (role) {
    var r = entry.roles[role], out = {};
    if (r && r.tier !== undefined) out.tier = r.tier;
    if (r && r.timeoutMinutes !== undefined) out.timeoutMinutes = r.timeoutMinutes;
    if (Object.keys(out).length) roles[role] = out;
  });
  if (Object.keys(roles).length) next.roles = roles;
  var args = {};
  Object.keys(entry.args || {}).forEach(function (key) { if (typeof entry.args[key] === 'boolean') args[key] = entry.args[key]; });
  if (Object.keys(args).length) next.args = args;
  return next;
}
function setRecipeEntry(overrides, name, entry) {
  var next = Object.assign({}, overrides), compact = compactEntry(entry);
  if (Object.keys(compact).length) next[name] = compact; else delete next[name];
  return next;
}
function setRoleOverride(overrides, name, role, patch) {
  var entry = overrides[name] || {}, roles = Object.assign({}, entry.roles);
  roles[role] = Object.assign({}, roles[role], patch);
  return setRecipeEntry(overrides, name, Object.assign({}, entry, { roles: roles }));
}
function recipeOverridesInvalid(overrides) {
  return Object.keys(overrides || {}).some(function (name) {
    var roles = (overrides[name] && overrides[name].roles) || {};
    return Object.keys(roles).some(function (role) {
      var m = roles[role].timeoutMinutes;
      return m !== undefined && !(Number.isInteger(m) && m >= 1 && m <= 240);
    });
  });
}

// Setup warnings for the saved route list; a route without a saved tier routes as medium.
function tierWarnings(value) {
  if (!value.enabled || !value.allowedModels.length) return [];
  var counts = { strong: 0, medium: 0, light: 0 };
  value.allowedModels.forEach(function (route) {
    var entry = value.modelTiers.find(function (item) { return item.provider === route.provider && item.model === route.model; });
    counts[entry ? entry.tier : 'medium'] += 1;
  });
  var warnings = [];
  if (counts.strong === 0) warnings.push('noStrong'); else if (counts.strong === 1) warnings.push('oneStrong');
  if (counts.medium === 0) warnings.push('noMedium');
  return warnings;
}
// 16px stroke icons for the model cards; buttons carry the accessible label.
var SETTINGS_ICON_PATHS = {
  up: 'M8 13V3M3.5 7.5 8 3l4.5 4.5',
  down: 'M8 3v10M3.5 8.5 8 13l4.5-4.5',
  trash: 'M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.5h6.6L12 4M6.75 6.5v4.5M9.25 6.5v4.5',
};
function settingsIcon(name) {
  return h('svg',{width:16,height:16,viewBox:'0 0 16 16',fill:'none',stroke:'currentColor',strokeWidth:1.5,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':'true',focusable:'false'},h('path',{d:SETTINGS_ICON_PATHS[name]}));
}
// The router compares only routes of one tier, so the editor groups routes by tier and saves
// allowedModels as strong, then medium, then light routes; order within a group is its priority.
var TIER_ORDER = ['strong', 'medium', 'light'];
function routeTier(value, route) {
  var entry = value.modelTiers.find(function (item) { return item.provider === route.provider && item.model === route.model; });
  return entry ? entry.tier : 'medium';
}
function groupRoutes(value) {
  var groups = { strong: [], medium: [], light: [] };
  value.allowedModels.forEach(function (route) { groups[routeTier(value, route)].push(route); });
  return groups;
}
function routesFromGroups(value, groups) {
  var allowedModels = [], modelTiers = [];
  TIER_ORDER.forEach(function (tier) {
    groups[tier].forEach(function (route) {
      allowedModels.push({ provider: route.provider, model: route.model });
      modelTiers.push({ provider: route.provider, model: route.model, tier: tier });
    });
  });
  return Object.assign({}, value, { allowedModels: allowedModels, modelTiers: modelTiers });
}
function moveRoute(list, index, delta) {
  var target = index + delta;
  if (target < 0 || target >= list.length) return list;
  var next = list.slice();
  next[index] = list[target]; next[target] = list[index];
  return next;
}

function RecipeCanvas(props) {
  var t = props.t, recipes = props.recipes, overrides = props.overrides || {};
  var namePair = useState(recipes.length ? recipes[0].name : null), selectedName = namePair[0], selectName = namePair[1];
  var rolePair = useState(null), selectedRole = rolePair[0], selectRole = rolePair[1];
  if (!recipes.length) return null;
  var recipe = recipes.find(function (r) { return r.name === selectedName; }) || recipes[0];
  var entry = overrides[recipe.name] || {};
  var roleOverride = function (role) { return (entry.roles && entry.roles[role]) || {}; };
  var tierOf = function (info) { return roleOverride(info.role).tier || info.tier; };
  var customized = function (role) { var o = roleOverride(role); return o.tier !== undefined || o.timeoutMinutes !== undefined; };
  var roleInfo = recipe.roles.find(function (r) { return r.role === selectedRole; });
  var update = function (next) { props.onChange(next); };
  var chooseRecipe = function (name) { selectName(name); selectRole(null); };
  var tabKey = function (event) {
    var index = recipes.indexOf(recipe), delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    if (props.dir === 'rtl') delta = -delta;
    event.preventDefault();
    chooseRecipe(recipes[(index + delta + recipes.length) % recipes.length].name);
  };
  var nodes = [];
  recipe.stages.forEach(function (stage, index) {
    if (index) nodes.push(h('li', { key: 'c' + index, className: 'ars-canvas-link', 'aria-hidden': 'true' }));
    nodes.push(h('li', { key: stage.id, className: 'ars-canvas-node', 'data-stage': stage.id },
      h('div', { className: 'ars-canvas-node-head' }, h('span', { className: 'ars-canvas-step' }, String(index + 1)), h('strong', { dir: 'ltr' }, stage.id)),
      stage.loop || stage.parallel ? h('div', { className: 'ars-canvas-badges' },
        stage.loop ? h('span', { className: 'ars-canvas-badge' }, '\u21bb ', t('loopBadge')) : null,
        stage.parallel ? h('span', { className: 'ars-canvas-badge' }, '\u21c9 ', t('parallelBadge')) : null) : null,
      stage.detail ? h('p', { className: 'ars-canvas-detail' }, stage.detail) : null,
      h('div', { className: 'ars-canvas-roles' }, stage.roles.map(function (role) {
        var info = recipe.roles.find(function (r) { return r.role === role; });
        var o = roleOverride(role);
        return h('button', { key: role, type: 'button', className: 'ars-canvas-role', 'data-role': role, 'data-tier': tierOf(info), 'data-custom': customized(role) ? 'true' : undefined,
          'aria-pressed': selectedRole === role, onClick: function () { selectRole(selectedRole === role ? null : role); } },
          h('span', { dir: 'ltr' }, role),
          h('small', null, t(tierOf(info)), o.timeoutMinutes !== undefined ? ' · ' + t('minutes', { n: o.timeoutMinutes }) : ''));
      }))));
  });
  var inspector = roleInfo ? h('div', { className: 'ars-canvas-inspector', role: 'group', 'aria-label': t('stepRole') + ' ' + roleInfo.role },
    h('div', { className: 'ars-canvas-inspector-head' }, h('strong', { dir: 'ltr' }, roleInfo.role),
      customized(roleInfo.role) ? h('button', { type: 'button', className: 'ars-settings-remove', onClick: function () { update(setRoleOverride(overrides, recipe.name, roleInfo.role, { tier: undefined, timeoutMinutes: undefined })); } }, t('reset')) : null),
    h('div', { className: 'ars-canvas-fields' },
      h('label', null, h('span', null, t('tier')),
        h('select', { 'aria-label': t('tier') + ' ' + roleInfo.role, value: tierOf(roleInfo), disabled: roleInfo.locked, onChange: function (event) {
          var tier = event.target.value;
          update(setRoleOverride(overrides, recipe.name, roleInfo.role, { tier: tier === roleInfo.tier ? undefined : tier }));
        } }, ['strong', 'medium', 'light'].map(function (tier) { return h('option', { key: tier, value: tier }, t(tier)); }))),
      h('label', null, h('span', null, t('timeout')),
        h('input', { 'aria-label': t('timeout') + ' ' + roleInfo.role, type: 'number', min: 1, max: 240, step: 1, inputMode: 'numeric', placeholder: t('recipeDefault'),
          value: roleOverride(roleInfo.role).timeoutMinutes === undefined ? '' : String(roleOverride(roleInfo.role).timeoutMinutes),
          onChange: function (event) {
            var raw = event.target.value;
            update(setRoleOverride(overrides, recipe.name, roleInfo.role, { timeoutMinutes: raw === '' ? undefined : Number(raw) }));
          } }))),
    h('small', { className: 'ars-canvas-note' }, roleInfo.locked ? t('tierLocked') : t(tierOf(roleInfo) + 'Hint')))
    : h('p', { className: 'ars-canvas-note' }, t('roleHint'));
  return h('div', { className: 'ars-recipes' },
    h('div', { className: 'ars-settings-section-title' }, h('h2', null, t('recipes')), h('span', { className: 'ars-settings-count' }, recipes.length)),
    h('p', { className: 'ars-canvas-note' }, t('recipesHint')),
    h('div', { className: 'ars-recipe-tabs', role: 'tablist', 'aria-label': t('recipes'), onKeyDown: tabKey }, recipes.map(function (r) {
      var e = overrides[r.name] || {};
      return h('button', { key: r.name, type: 'button', role: 'tab', id: 'ars-recipe-tab-' + r.name, 'aria-selected': r.name === recipe.name, tabIndex: r.name === recipe.name ? 0 : -1,
        'aria-controls': 'ars-recipe-panel', 'data-off': e.disabled === true ? 'true' : undefined, onClick: function () { chooseRecipe(r.name); } },
        h('span', { dir: 'ltr' }, r.name), Object.keys(e).length ? h('i', { className: 'ars-recipe-dot', title: t('customized') }) : null);
    })),
    h('div', { className: 'ars-recipe-panel', role: 'tabpanel', id: 'ars-recipe-panel', 'aria-labelledby': 'ars-recipe-tab-' + recipe.name },
      recipe.description ? h('p', { className: 'ars-recipe-description' }, recipe.description) : null,
      h('label', { className: 'ars-recipe-switch' }, h('span', null, h('strong', null, t('recipeEnabled')), h('small', null, t('recipeEnabledHint'))),
        h('input', { type: 'checkbox', role: 'switch', 'aria-label': t('recipeEnabled') + ' ' + recipe.name, checked: entry.disabled !== true,
          onChange: function (event) { update(setRecipeEntry(overrides, recipe.name, Object.assign({}, entry, { disabled: !event.target.checked }))); } })),
      recipe.options.length ? h('div', { className: 'ars-recipe-options' }, h('h3', null, t('options')), recipe.options.map(function (option) {
        var current = entry.args && typeof entry.args[option.key] === 'boolean' ? entry.args[option.key] : option.default;
        return h('label', { key: option.key, className: 'ars-recipe-switch' }, h('span', null, h('strong', { dir: 'ltr' }, option.key), h('small', null, option.detail.replace(/^boolean,\s*(default (true|false);?\s*)?/, ''))),
          h('input', { type: 'checkbox', role: 'switch', 'aria-label': option.key, checked: current, onChange: function (event) {
            var args = Object.assign({}, entry.args);
            if (event.target.checked === option.default) delete args[option.key]; else args[option.key] = event.target.checked;
            update(setRecipeEntry(overrides, recipe.name, Object.assign({}, entry, { args: args })));
          } }));
      })) : null,
      h('h3', null, t('flow')),
      h('div', { className: 'ars-canvas' }, h('ol', { className: 'ars-canvas-track', dir: 'ltr' }, nodes)),
      inspector));
}

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
  var recipeOverrides = value.recipeOverrides || {};
  var timeoutsInvalid = recipeOverridesInvalid(recipeOverrides);
  function change(next) { setError(null); setDraft({revision:draft ? draft.revision : snapshot.revision,value:next}); }
  var groups = groupRoutes(value);
  function edit(tier, list) {
    var next = Object.assign({}, groups); next[tier] = list;
    change(routesFromGroups(value, next));
  }
  function remove(tier, index) { edit(tier, groups[tier].filter(function (_, i) { return i !== index; })); }
  function move(tier, index, delta) { edit(tier, moveRoute(groups[tier], index, delta)); }
  function add(tier, route) { edit(tier, groups[tier].concat([route])); }
  // A route moved to another tier joins the end of that tier.
  function setTier(from, index, to) {
    var next = Object.assign({}, groups), route = groups[from][index];
    next[from] = groups[from].filter(function (_, i) { return i !== index; });
    next[to] = groups[to].concat([route]);
    change(routesFromGroups(value, next));
  }
  async function save() {
    if (!draft || conflicted || invalid || timeoutsInvalid || busy || !snapshot.writable) return;
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
      h('p',{className:'ars-settings-hint'},t('orderHint')),
      TIER_ORDER.map(function (tier) {
        var list = groups[tier], last = list.length - 1;
        return h('section',{key:tier,className:'ars-settings-group','data-tier':tier,'aria-label':t(tier)},
          h('div',{className:'ars-settings-group-head'},h('h3',null,t(tier)),h('span',{className:'ars-settings-count'},list.length)),
          h('p',{className:'ars-settings-group-about'},t(tier+'About')),
          list.length ? h('div',{className:'ars-settings-routes'},list.map(function (route, index) {
            return h('div',{key:route.provider+'\0'+route.model,className:'ars-settings-route'},
              h('span',{className:'ars-settings-rank',title:t('priority',{n:index+1}),'aria-label':t('priority',{n:index+1})},String(index+1)),
              h('div',{className:'ars-settings-identity',dir:'ltr',title:route.provider+' / '+route.model},h('strong',null,route.model),h('span',null,route.provider)),
              h('div',{className:'ars-settings-actions-row'},
                last>0 ? h('button',{type:'button',className:'ars-settings-icon',disabled:index===0,onClick:function () {move(tier,index,-1);},'aria-label':t('moveUp')+' '+route.model,title:t('moveUp')},settingsIcon('up')) : null,
                last>0 ? h('button',{type:'button',className:'ars-settings-icon',disabled:index===last,onClick:function () {move(tier,index,1);},'aria-label':t('moveDown')+' '+route.model,title:t('moveDown')},settingsIcon('down')) : null,
                h('button',{type:'button',className:'ars-settings-icon ars-settings-remove',onClick:function () {remove(tier,index);},'aria-label':t('remove')+' '+route.model,title:t('remove')},settingsIcon('trash'))),
              h('select',{className:'ars-settings-move','aria-label':t('tier')+' '+route.model,title:t('tier'),value:tier,onChange:function (event) {setTier(tier,index,event.target.value);}},TIER_ORDER.map(function (item) {return h('option',{key:item,value:item},t(item));})));
          })) : h('p',{className:'ars-settings-empty'},t('emptyTier')),
          h('div',{className:'ars-settings-add'},h('label',null,h('select',{'aria-label':t('addTo',{tier:t(tier)}),value:'',onChange:function (event) {
            if (event.target.value==='') return;
            var route=candidates[Number(event.target.value)];
            if (route) add(tier,route);
          }},h('option',{value:''},t('addTo',{tier:t(tier)})),candidates.map(function (route,index) {return h('option',{key:route.provider+'\0'+route.model,value:String(index)},route.provider+' / '+route.model);})))));
      }),
      h('div',{className:'ars-settings-catalog'},h('p',{className:'ars-settings-hint'},t('tiersNote')),h('button',{type:'button',onClick:function () {refreshCatalog(catalogRevision+1);}},t('refresh'))),
      tierWarnings(value).map(function (key) {return h('p',{key:key,role:'status','data-warning':key},t(key));}),
      catalogError ? h('p',{role:'status'},t('unavailable')) : null,
      invalid ? h('p',{role:'alert'},t('empty')) : null,
      conflicted ? h('p',{role:'alert'},t('conflict')) : null,
      error ? h('p',{role:'alert'},t(error)) : null,
      h(RecipeCanvas,{t:t,dir:t('direction'),recipes:props.recipes || [],overrides:recipeOverrides,onChange:function (next) {change(Object.assign({},value,{recipeOverrides:next}));}}),
      timeoutsInvalid ? h('p',{role:'alert'},t('timeoutInvalid')) : null,
      h('footer',{className:'ars-settings-actions'},h('span',null,t('saved')),h('div',null,h('button',{type:'button',className:'ars-settings-save',disabled:!draft||conflicted||invalid||timeoutsInvalid,onClick:save},t('save')),
      h('button',{type:'button',disabled:!draft,onClick:function () {setDraft(null);setError(null);}},t('discard'))))));
}
function registerAutoSettings(ctx) {
  ctx.effect(function () { return ctx.locale.register(SETTINGS_NS,{en:settingsEn,ar:settingsEn,zh:settingsEn}); }, 'auto-subagents: settings locale');
  var form=ctx.configForms.get('auto-model-selection');
  var face={hooks:{autoSettings:form},recipes:RECIPE_CATALOG,catalog:function () {return ctx.remote.session.modelCatalog();},save:function (value,revision) {return form.mutate(['enabled','allowedModels','modelTiers','recipeOverrides'].map(function (field) {return {op:'set',path:[field],value:field==='recipeOverrides' ? (value[field] || {}) : value[field]};}),revision);}};
  ctx.effect(function () {return ctx.configForms.whileServed(['auto-model-selection'],function () {return ctx.slots.inject('plugins.bundle.config',function () {return ctx.slots.register({name:'plugins.bundle.config',key:'dsh-auto-subagents',locale:SETTINGS_NS,inject:function () {return face;}},AutoSettings);});});},'auto-subagents: settings page');
}
