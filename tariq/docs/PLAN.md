# خطة بناء نسختك الخاصة من DSH (Fork)

> تحديث 4 أكتوبر 2026: اندمج Auto مع DSH ‏0.2.1-alpha.1. المرجع للحالة الحالية هو [سجل التحقق](AUTO-V020-STATUS.md). الأقسام التالية تحفظ قرارات وفحص التثبيت القديم؛ تعليمات الترقيع والإصدارات القديمة لا تُطبق على النسخة الحالية. النطاق المعتمد Auto فقط، وسند وAgent Teams مستبعدان. الإصلاحات والتحقق والترحيل أولًا، والواجهة أخيرًا.

> تاريخ الفحص: 3 أكتوبر. المصدر: فحص فعلي للملفات في `~/.local/share/deepseek-harness`.
> المسار الأساسي في هذي الوثيقة: `D=/Users/tariq/.local/share/deepseek-harness`.

---

## 0. الخلاصة

- النسخة اللي عندك هي **DSH 0.1.5-rc.2**. آخر نسخة نازلة رسميًا هي **0.2.1-alpha.1**. يعني أنت **متأخر تقريبًا 10 إصدارات** (rc.3، و0.1.6، و0.1.7، و0.2.0، و0.2.1).
- تعديلاتك ما هي إضافة وحدة. هي **5 طبقات مترابطة**، منها **13 ملف معدّل** داخل `runtime/node_modules` (12 للوكلاء التلقائيين و1 لألوان النماذج)، و**3 ملفات فيها مسارات مطلقة مكتوبة داخلها**، وهذي تخرب لو انتقلت لجهاز ثاني أو غيرت مكان التثبيت.
- الفورك يحل المشكلتين: التعديلات تصير **commits** داخل الكود المصدري، والمسارات المطلقة تتحول لاستيراد عادي بأسماء الحزم.
- **أول خطوة قبل أي شي: احذف المفتاح السري المكتوب في `cordis.patch.yml` واعتبره مكشوف** (التفاصيل في القسم 6).

---

## 1. خريطة التبعيات الكاملة (وش يعتمد على وش)

```
                         ┌───────────────────────────────────────────┐
                         │ DSH runtime 0.1.5-rc.2 (241 حزمة @deepseek-ai) │
                         └───────────────────────────────────────────┘
            ▲ تعديل مباشر (12)         ▲ تعديل مباشر (1)          ▲ import بمسار مطلق
            │                          │                          │
 [A] core-patches  ────────► [B] dsh-auto-subagents ◄──── [C] local-plugins shims
   (tool-subagent يستورد       (الإضافة نفسها)              (لازم تبقى؛ tool-subagent
    router.mjs بمسار مطلق)            ▲                     يستوردها بالمسار)
                                     │ بالاسم dsh-auto-subagents/*
                         [D] preset auto-subagents + recipes/feature-pipeline
                                     │
 [E] subagent-model-colors (تعديل dsh-client-ui-subagent)     مستقل
 [F] sanad-team preset (يستورد dsh-llm و dsh-tools بمسار مطلق)  مستقل
 [G] dsh-rtl-arabic (إضافة محلية في profiles/web/plugins)       مستقل
 [H] إعدادات profile web: cordis.patch.yml + 12 إضافة من npm/GitHub
```

### [A] التعديلات الأساسية على الحزم (12 ملف، كلها applied حاليًا)

| # | المعرّف | الحزمة / الملف | وش يسوي |
|---|---|---|---|
| 1 | tool-subagent | `dsh-tool-subagent/lib/index.js` | معاملات tier وverifies، والـrouter، وفرض الاختيار. **يستورد router بمسار مطلق** |
| 2 | tool-subagent-types | `dsh-tool-subagent/lib/types/index.d.ts` | تعريفات الأنواع |
| 3 | model-selection-settings | `dsh-tool-subagent/lib/model-selection-settings.js` | إعداد `modelTiers` (strong/medium/light) |
| 4 | model-selection-settings-types | `.../types/model-selection-settings.d.ts` | تعريفات الأنواع |
| 5 | agent-loop | `dsh-agent-loop/lib/index.js` | نقطة ربط `agent/request-prepare-error` قبل إرسال الطلب، ومنها يشتغل التبديل لمزود بديل |
| 6 | agent-runtime-types | `dsh-agent/lib/types/runtime-types.d.ts` | تعريف الحدث |
| 7 | scope-invariant | `dsh-scope/lib/invariant.js` | يحدد subject للحدث الجديد |
| 8 | tool-cordis-metadata | `dsh-tool-cordis/lib/index.js` | metadata للحدث |
| 9 | session | `dsh-session/lib/index.js` | توافق السجل التاريخي مع أحداث `auto-subagent/*` |
| 10 | session-types | `dsh-session/lib/types/index.d.ts` | تعريفات |
| 11 | settings-ui-client | `dsh-client-ui-settings-plugins/lib/client.js` | قائمة اختيار tier لكل نموذج في الإعدادات |
| 12 | settings-ui-card-types | `.../subagent-model-selection-card-controller.d.ts` | تعريفات |

**ملاحظة مهمة:** هذي التعديلات مطبقة على ملفات **مبنية** (`lib/*.js`). في الفورك لازم تطبق نفس المنطق على ملفات **المصدر** (`packages/*/src/*.ts`)، يعني تعيد كتابتها يدويًا مو تنسخها. الملفات `original/patched` في `core-patches/` هي المرجع اللي تشتغل عليه، وتشوف الفرق بينها بأمر `diff`.

مجموعات التعديلات اللي تعتمد على بعض، ولازم تنتقل مع بعض:
- **مجموعة الحدث الجديد** (5، 6، 7، 8): لو نقصت وحدة منها، الحدث `agent/request-prepare-error` ما يتسجل أو يرفضه scope.
- **مجموعة الـtiers** (1، 2، 3، 4، 11، 12): الإعداد في الخلفية والواجهة.
- **مجموعة السجل** (9، 10): لو ما نقلتها، الجلسات القديمة اللي فيها أحداث `auto-subagent/*` ممكن ما تفتح.

### [B] الإضافة `dsh-auto-subagents` (v0.2.0)
- تعتمد **فقط** على `node:*` وملفاتها الداخلية، وما تستورد حزم DSH مباشرة. هذا شي ممتاز، لأن الربط كله يصير عن طريق Cordis، والـpreset يحمّلها بأسماء الحزم.
- واجهتها (`lib/client.js`) تحتاج هالحزم تتحمل قبلها: `dsh-api-session-controller`، `dsh-client-locale`، `dsh-client-ui-chat`، `dsh-client-ui-conversation`، `dsh-client-ui-renderer`، `dsh-client-ui-session`.
- التثبيت الحالي: `link:` في `profiles/web/package.json`.
- مسارات التثبيت كلها محصورة في `lib/dsh-paths.mjs` (DSH_HOME، DSH_RUNTIME_DIR، DSH_AUTO_RECIPES_DIR)، وهذا يسهّل النقل.

### [C] ملفات الربط في `home/local-plugins/auto-subagent-routing/`
- `router.mjs`، `runtime.mjs`، `coordinator.mjs`، `recipes.mjs`: ملفات تعيد تصدير محتوى من [B].
- **سبب وجودها الوحيد:** التعديل رقم 1 يستورد `.../local-plugins/auto-subagent-routing/router.mjs` بمسار مطلق.
- **في الفورك تنحذف.** يصير `dsh-tool-subagent` يستورد `dsh-auto-subagents/router`، أو الأفضل يكون فيه نقطة ربط تسجّل الـrouter كخدمة Cordis.

### [D] الـpreset والوصفات
- `home/.agent-presets/auto-subagents/`: الملفات `agent.cordis.yml` و`preset.yml` و`auto-subagents.test.mjs`. تشير لـ`dsh-auto-subagents/runtime` و`/coordinator` و`/recipes`.
- `home/recipes/feature-pipeline/`: الملفات `script.js` و`meta.json` و`recipe.lock.json`. **لو غيرت السكربت لازم تعيد الموافقة** بأمر `approve-recipe.mjs`.
- `home/recipes/.runs/*.json`: سجلات تشغيل فيها مسارات مشاريعك. **لا تحطها في git.**

### [E] ألوان النماذج (`local-changes/subagent-model-colors`)
- تعديل مباشر على `@deepseek-ai/dsh-client-ui-subagent/lib/client.js`، **وهذا خارج الـ12** وما يشمله `check:core-patches`. يعني لو حدّثت تفقده بدون ما يطلع لك أي تنبيه.
- مستقل عن [B]. فيه سكربت `apply.mjs` واختبار `model-badge.test.mjs`.

### [F] مود فريق سند (`.agent-presets/sanad-team`)
- `sanad-mode.mjs` يستورد `file:///.../runtime/node_modules/@deepseek-ai/dsh-llm` و`dsh-tools` **بمسار مطلق**.
- المصدر الأصلي في `~/Desktop/sanad-team-src` وفيه 142 اختبار.
- ملاحظة: في `profiles/web/cordis.patch.yml` مكتوب إن حالة `sanad_*` القديمة صارت "تاريخية"، والتعريف الجديد (ملف Agent Teams اسمه sanad) هو المعتمد. **قرر: هل ترحّل الـpreset القديم ولا تكتفي بملف Agent Teams؟**

### [G] `dsh-rtl-arabic`
- إضافة محلية في `profiles/web/plugins/dsh-rtl-arabic/` تخلي الرسائل العربية من اليمين لليسار تلقائيًا. تُحمَّل من `cordis.patch.yml` بالمسار `./plugins/dsh-rtl-arabic/deploy-4.js`.
- **في الفورك ادمجها في الواجهة نفسها،** ما يحتاج تبقى إضافة.

### [H] الإضافات الخارجية من npm/GitHub (في profile web)
`@mars-sea/dsh-commandcode-provider@0.11.11` · `@nanmicoder/dsh-agent-teams@0.1.21` · `@rex-harness/ui-workflow` (latest tgz) · `@tt-a1i/archify-dsh@0.1.0` · `@w2112515/dsh-plugin-marketplace` (commit مثبّت) · `dsh-better-sidebar@0.19.1` · `dsh-chrome` · `dsh-ego-browser` · `dsh-plugin-subscriptions@0.9.4` · `dsh-token-usage-stats@0.3.14` · `dshmarket`

**خطر عند الترقية:** هذي الإضافات مكتوبة على API الإصدار 0.1.5. لما تنتقل لـ0.2.x **ممكن بعضها يتعطل**. لازم تتأكد من كل وحدة إنها تدعم الإصدار الجديد قبل تعتمد عليها.

---

## 2. القرار الأول: على أي إصدار تبني؟

| الخيار | المميزات | العيوب |
|---|---|---|
| **أ. فرع من `dsh-v0.1.5-rc.2`** (نفس اللي عندك) | التعديلات تنطبق عليه حرفيًا تقريبًا، والاختبارات تثبت إن كل شي يشتغل | ترث ديون 10 إصدارات، وأول دمج مع main بيكون كبير |
| **ب. فرع من آخر نسخة (`main` / 0.2.1)** | تبدأ من آخر الأشياء، وما يتراكم عليك تأخير | لازم تعيد كتابة التعديلات الـ12 على كود تغيّر، وممكن بعضها صار له بديل رسمي |

**التوصية: اسلك الطريقين على مرحلتين.**
1. فرع `tariq/baseline-0.1.5` من `dsh-v0.1.5-rc.2`، وتنقل له التعديلات وتتأكد إن الاختبارات تمر. هذا يعطيك **نسخة مرجعية تشتغل**.
2. بعدها `git rebase --onto main` أو تعيد تطبيق التعديلات commit ورا commit على main. وقبل ما تنقل كل تعديل، **شيك هل صار له بديل في upstream**. مثلًا تحقق من الحدث `request-prepare-error` ومن `modelTiers` وتوافق السجل. لو لقيت بديل رسمي، احذف التعديل حقك.

---

## 3. هيكل المستودع المقترح

```
my-dsh/                         ← fork من deepseek-ai/deepseek-harness
├── apps/
│   ├── cli/                    ← upstream (ما تلمسه إلا لو لزم)
│   ├── web/                    ← upstream
│   └── tariq-web/              ← (اختياري) shell الواجهة حقك
├── packages/
│   ├── dsh-tool-subagent/      ← upstream + تعديلاتك (commits واضحة)
│   ├── dsh-agent-loop/         ← upstream + نقطة الربط
│   ├── ...                     ← باقي التعديلات
│   └── tariq/                  ← كل شي خاص فيك بمجلد واحد
│       ├── auto-subagents/     ← [B] بعد ما تنقله، والـshims [C] تنحذف
│       ├── rtl-arabic/         ← [G]
│       ├── model-colors/       ← [E] (أو تعديل مباشر في dsh-client-ui-subagent)
│       └── sanad-team/         ← [F] (لو قررت تبقيه)
├── presets/tariq/              ← auto-subagents، multi-agent، sanad-team
├── recipes/feature-pipeline/   ← بدون .runs
└── docs/tariq/                 ← CHANGES.md: قائمة بكل تعديل على upstream وسببه
```

**القاعدة الذهبية:** أي ملف upstream تعدله، تسجله في `docs/tariq/CHANGES.md` وتكتب له commit بالصيغة: `tariq(core): <الوصف>`. بكذا تعرف بالضبط وش لازم تراجعه مع كل دمج.

---

## 4. خطوات التنفيذ بالترتيب

### المرحلة 0: نسخة احتياطية وتأمين (يوم واحد)
```sh
D=/Users/tariq/.local/share/deepseek-harness
# 1) نسخة احتياطية كاملة (بدون sessions الثقيلة لو تبي)
tar czf ~/dsh-backup-$(date +%Y%m%d).tgz -C $D home local-changes runtime/package.json
# 2) تحقق من الحالة الحالية
cd $D/home/plugins-src/dsh-auto-subagents && npm test && npm run check:core-patches
node $D/local-changes/subagent-model-colors/apply.mjs
```
- **ألغِ المفتاح `TYPESAFE_API_KEY`** وأنشئ واحد جديد (القسم 6).

### المرحلة 1: تجهيز الفورك (يوم إلى يومين)
```sh
# على GitHub: Fork لـ deepseek-ai/deepseek-harness (خليه Private لو تبي)
git clone git@github.com:<you>/deepseek-harness.git ~/code/robban
cd ~/code/robban
git remote add upstream https://github.com/deepseek-ai/deepseek-harness.git
git fetch upstream --tags
git checkout -b tariq/baseline-0.1.5 dsh-v0.1.5-rc.2
# اقرأ README/CONTRIBUTING لمعرفة مدير الحزم (غالبًا pnpm) وأوامر build/test
pnpm install && pnpm build && pnpm test
```
- **معيار النجاح:** تبني النسخة **بدون أي تعديل** وتشغلها على منفذ ثاني (مثلًا 3091) مع `DSH_HOME` منفصل، وتشتغل مثل نسختك الحالية.
- **تأكد إن النسخة المبنية تطابق npm:** قارن `packages/dsh-tool-subagent/lib/index.js` بعد البناء مع `core-patches/tool-subagent/original.js`. لو تطابقوا، يكون أساسك صحيح 100%.

### المرحلة 2: نقل التعديلات الـ12 (3 إلى 5 أيام)
لكل مجموعة، بهالترتيب:
1. **الحدث** (5، 6، 7، 8). هي الأساس وكل شي بعدها يعتمد عليها.
2. **السجل** (9، 10).
3. **الـtiers** (3، 4، ثم 1، 2، ثم 11، 12).

لكل تعديل:
```sh
diff -u core-patches/<id>/original.js core-patches/<id>/patched.js   # افهم وش الفرق
# طبّق نفس المنطق على packages/<pkg>/src/*.ts
pnpm --filter <pkg> build
cmp packages/<pkg>/lib/index.js core-patches/<id>/patched.js           # النتيجة المثالية: تطابق أو فرق بسيط مفهوم
git commit -m "tariq(core): <id> — <purpose>"
```
- في التعديل رقم 1: **غيّر الاستيراد المطلق** إلى `import('dsh-auto-subagents/router')`، أو الأفضل تسوي نقطة ربط تسجّل الـrouter كخدمة. بعدها احذف [C].

### المرحلة 3: نقل الإضافة والـpresets (يومين إلى 3)
- انقل [B] إلى `packages/tariq/auto-subagents` وخليه جزء من الـworkspace بدل `link:`.
- احذف من الإضافة: `core-patches/` و`scripts/reapply-core-patches.mjs` و`test/core-patches.test.mjs`، لأنها ما عادت لازمة. **خلّ الاختبارات الثانية كلها.**
- عدّل `lib/dsh-paths.mjs`: احذف `DSH_RUNTIME_DIR` إذا ما عاد له استخدام.
- انقل [E] كتعديل على `dsh-client-ui-subagent` المصدري، مع `model-badge.test.mjs`.
- انقل [F]: بدّل `file:///...` بأسماء الحزم `@deepseek-ai/dsh-llm` و`@deepseek-ai/dsh-tools`، وشغّل الـ142 اختبار.
- انقل [G] إلى الواجهة.
- خلّ الـpresets تنشحن مع البرنامج (bundled presets) بدل `home/.agent-presets`.

### المرحلة 4: التحقق الكامل (يوم إلى يومين)
```sh
pnpm test                                    # اختبارات upstream كلها
node --test packages/tariq/auto-subagents/test/*.test.mjs packages/tariq/auto-subagents/test/legacy/*.test.mjs
node --test presets/tariq/auto-subagents/auto-subagents.test.mjs
```
وبعدها تجربة حية على منفذ 3091 مع `DSH_HOME` تجريبي:
- [ ] مود Auto: المنسق ما يقدر يكتب أو يشغل bash، والـsubagents تقدر.
- [ ] 3 مهام متوازية تتوزع على 3 نماذج مختلفة.
- [ ] قائمة اختيار الـtier تظهر في الإعدادات وتنحفظ.
- [ ] `run_recipe feature-pipeline` يشتغل، وبطاقة التشغيل تظهر وتبقى بعد تحديث الصفحة.
- [ ] جلسة قديمة من `home/sessions` تفتح عادي (هنا يبان تعديل السجل).
- [ ] ألوان النماذج، واتجاه العربي من اليمين، وفريق سند.
- [ ] كل إضافة من [H] تتحمل بدون أخطاء.

### المرحلة 5: الانتقال لآخر إصدار (أسبوع، حسب حجم التغييرات)
```sh
git checkout -b tariq/main upstream/main
git cherry-pick <commits من tariq/baseline-0.1.5>   # واحد واحد، وحل التعارضات
```
- مع كل commit: **ابحث في `git log upstream` هل أضافوا نفس الشي**. لو أضافوه، احذف تعديلك واعتمد على حقهم.
- وتأكد من توافق إضافات [H] مع 0.2.x.

### المرحلة 6: التشغيل اليومي
- شغّل نسختك من المصدر بدل `runtime/` اللي مثبت من npm، واستخدم **نفس `DSH_HOME`** عشان تبقى جلساتك وإعداداتك. **خذ نسخة احتياطية من `home/sessions` قبل أول تشغيل.**
- لا توقف `dsh web` الحالي وأنت شغال إلا بعد ما تخلص التجربة على المنفذ الثاني.

### المرحلة 7: الواجهة الخاصة (بعد ما يستقر كل شي)
- الاسم والشعار والألوان والخطوط العربية في `apps/web`، أو في shell منفصل `apps/tariq-web` عشان التعارضات تقل.
- لو تبي تطبيق سطح مكتب: Tauri (أخف) أو Electron، يغلّف `dsh web` المحلي.

---

## 5. سحب تحديثات DeepSeek بعدين

المسار الحالي موثّق في [الحفاظ على تحديثات DSH](../README.md#keeping-dsh-updates): جلب `upstream/master`، ثم دمج التحديث على فرع ونسخة عمل منفصلين بعد حفظ الإصلاحات المحلية. يراجع الدمج تعديل حفظ علامة `ignorable` في Session، ويختبر مزود LLM المملوك لـAuto والبناء والتوافق حتى لو لم يظهر تعارض Git. استعادة أخطاء تجهيز الطلب صارت داخل البلوق إن، ومصدر Agent وAgentLoop يطابق الأصل. تحديث npm الأصلي وحده قد يزيل تعديل Session المتبقي؛ لا يُستخدم بديلًا عن دمج المصدر. فحص 4 أكتوبر 2026 لم يجد أي commit من الأصل مفقودًا من فرع رُبّان الحالي. لا توجد جدولة آلية لجلب التحديثات.

---

## 6. أمان: لا تحط هذي في git أبدًا

| الملف | السبب |
|---|---|
| `home/profiles/web/cordis.patch.yml` | **فيه `TYPESAFE_API_KEY` مكتوب كنص صريح.** ألغِ المفتاح وبدّله بمتغير بيئة |
| `home/.credentials.yaml` | بيانات اعتماد |
| `home/.everything-oauth.json` | رموز OAuth |
| `home/plugins/subscriptions/auth.json` | مصادقة الاشتراكات |
| `home/settings.yaml*` | ممكن يكون فيها مفاتيح |
| `home/sessions/`، `storages/`، `recipes/.runs/` | محادثاتك ومسارات مشاريعك |

`.gitignore` الأساسي:
```
**/.credentials.yaml
**/*oauth*.json
**/auth.json
**/settings.yaml*
**/sessions/
**/storages/
**/recipes/.runs/
**/*.bak*
.env*
```
لو بتحط الإعدادات في الفورك، **انسخ قالب بدون أسرار** (`cordis.patch.example.yml`)، والقيم الحقيقية تقراها من متغيرات البيئة.

---

## 7. الرخصة والنشر
- DSH رخصته **MIT**، فيحق لك تعدل وتوزع حتى لو بشكل تجاري.
- **المطلوب منك بس:** تبقي ملف `LICENSE` الأصلي وإشعار حقوق النشر في نسختك.
- إضافات [H] كل وحدة لها رخصتها الخاصة، فشيك عليها قبل تدمجها في نسخة تنشرها.
- "DeepSeek" علامة تجارية، فلا تسمي منتجك باسم يوحي إنه رسمي.

---

## 8. المخاطر وكيف تتعامل معها

| الخطر | الاحتمال | كيف تتعامل معه |
|---|---|---|
| upstream غيّر بنية الحزم بين 0.1.5 و0.2.x | عالي | المرحلة 1 على 0.1.5 أول، وبعدين ترحّل خطوة خطوة |
| إضافات [H] تتعطل على 0.2.x | متوسط | تتحقق من كل وحدة، وتثبّت نسخها |
| الجلسات القديمة ما تفتح | متوسط | تعديل السجل (9، 10) + نسخة احتياطية من sessions + تجربة على منفذ ثاني |
| تفقد تعديل [E] بدون ما تنتبه | عالي حاليًا | في الفورك يصير commit ومعه اختبار |
| تسريب أسرار | **موجود فعلًا** | القسم 6 فورًا |
| تراكم فروقات كبيرة عن upstream | متوسط | دمج كل أسبوع أو أسبوعين + Pull Requests لـupstream |

---

## 9. أسئلة تحتاج قرار منك (تم الرد — انظر القسم 10)
1. الفورك **خاص (Private)** ولا عام؟
2. تبني على **0.1.5 أول ثم ترحّل** (هذا اللي أنصحك فيه) ولا تبدأ على main مباشرة؟
3. preset **فريق سند القديم** ترحّله ولا تكتفي بملف Agent Teams؟
4. الواجهة: **ويب فقط** ولا **تطبيق سطح مكتب**؟
5. أي إضافات [H] **أساسية** لازم تشتغل، وأي وحدة ممكن تستغني عنها؟

---

## 10. القرارات المعتمدة (تحديث)

| السؤال | القرار | أثره على الخطة |
|---|---|---|
| خاص أو عام | **عام** | القسم 6 صار **إجباري قبل أول push**. لازم تمسح المفتاح من **تاريخ git كامل** مو من آخر commit بس. وأي مسار فيه `/Users/tariq` ينشال من الكود والوثائق |
| مرحلتين | **نعم: 0.1.5 أول ثم ترقية** | **الهدف من الترقية صار `dsh-v0.2.0-rc.2` مو `main`**، لأن إضافة الاشتراكات ما تدعم إلا هذا الإصدار (التفاصيل تحت) |
| فريق سند | **النسخة الجديدة (ملف Agent Teams) بس** | ما ننقل `.agent-presets/sanad-team` ولا الملفات `sanad-*.mjs`. وبكذا تختفي واحدة من مشاكل المسارات المطلقة |
| الواجهة | **ويب أول، وسطح المكتب بعدين** | المرحلة 7 تكون ويب بس. نصمم الواجهة بطريقة تخلي تغليفها بـTauri سهل بعدين |
| الإضافات الأساسية | **الاشتراكات بس** | باقي إضافات [H] اختيارية، وما نوقف الترقية عشان وحدة منها |

### إضافة الاشتراكات: هل فيه أفضل منها؟

دورت في سوق إضافات DSH (93 نتيجة عن الاشتراكات و204 عن المزودين):

| الإضافة | المزودين | النجوم | الحالة |
|---|---|---|---|
| **`dsh-plugin-subscriptions` (V1ki)** (اللي عندك) | ChatGPT/Codex، Claude، Grok، GitHub Copilot، Google Antigravity | **★396** | آخر تحديث 28 سبتمبر، رخصة MIT |
| `dsh-codex-subscription` | ChatGPT/Codex بس | ★102 | مزود واحد |
| `dsh-subscription-login` | Codex، Claude، Copilot، OpenRouter | ★1 | واجهة تسجيل دخول بس، وجديدة |
| `dsh-llm-subscription` | Claude Code، Antigravity، Ollama | ★2 | صغيرة |
| `@dockyard-dsh/plugin` | مجموعة حسابات (macOS) | ★79 | آخر تحديث 3 سبتمبر |

**النتيجة: اللي عندك هي الأفضل، ولا تستبدلها.** هي الأكثر مزودين والأكثر استخدام، وتتحدث باستمرار. وفيها:
- **أكثر من حساب لكل مزود** مع مجموعة حسابات تتبدل تلقائي حسب الحصة المتبقية (`quota_aware`).
- تنتظر لين تنفتح نافذة الحد بدل ما يفشل الطلب. لازم تضيف `@deepseek-ai/dsh-llm-retry` للإعدادات عشان تشتغل هالميزة.
- أدوات `image_generate` و`video_generate` و`x_search` و`web_search`.
- عرض الحصة المستخدمة في شريط المحادثة.

**بس لازم تحدّثها:** عندك `0.9.4`، والأحدث `0.9.7`.

**الإصدارات اللي تدعمها 0.9.7 (هذا يحدد خطة الترقية كلها):**
- تدعم `0.1.5-rc.2`، يعني المرحلة 1 تشتغل عادي.
- تدعم `0.1.7-rc.x` و**`0.2.0-rc.2` بالضبط**. والمطوّر يقول بوضوح إن "Other `0.2` prereleases are not implicitly allowed".
- **ما تدعم `0.2.1-alpha.1`** (اللي هو `main` حاليًا).

إذن خطوات الترقية تصير: **`0.1.5-rc.2` → `0.2.0-rc.2`**. وما ننتقل لـ`main` إلا بعد ما يدعمه المطوّر.

**مزودين ثانيين بدون إضافة:**
- أي مزود يدعم صيغة OpenAI (مثل `xkiro` اللي تستخدمه الحين، وDeepSeek API، وOpenRouter، وGroq...) تعرّفه مباشرة في `settings.yaml` تحت `providers:`، وما يحتاج أي إضافة.
- لو تبي نماذج محلية: `dsh-llm-subscription` يضيف Ollama.
- لو تبي واجهة دخول موحدة فيها OpenRouter: `dsh-subscription-login`، ويشتغل مع الاشتراكات بدون تعارض. بس هو جديد (★1)، فجربه أول.

### في الفورك: كيف تضيف إضافة الاشتراكات؟
**خلها إضافة خارجية بنسخة مثبّتة، ولا تدمجها في الكود.** هي مشروع له مطوّر نشط ويحدّثها، ولو دمجتها تتحمل أنت صيانتها. في ملف الـprofile الافتراضي حق نسختك:
```json
"dsh-plugin-subscriptions": "0.9.7"
```
```yaml
- name: '@deepseek-ai/dsh-llm-retry'
- id: llm-subscriptions
  name: dsh-plugin-subscriptions
  config:
    pool: { enabled: true, strategy: quota_aware }
    rateLimit: { wait: true, maxWaitMs: 21600000 }
```
- **ملاحظة أمان:** الإضافة تحفظ الرموز في `~/.dsh/plugins/subscriptions/auth.json` (عندك في `home/plugins/subscriptions/auth.json`). هذا الملف ممنوع يدخل الفورك العام أبدًا.

### خطة الترقية بعد التعديل (يتبدل بها القسم 2 والمرحلة 5)
1. `tariq/baseline-0.1.5` ← `dsh-v0.1.5-rc.2` + تعديلاتك + subscriptions 0.9.7، وتتأكد إن الاختبارات تمر.
2. `tariq/main` ← `dsh-v0.2.0-rc.2` + نقل تعديلاتك commit ورا commit، وتشيك هل صار لأي تعديل بديل رسمي.
3. تتابع إصدارات `dsh-plugin-subscriptions`. أول ما يدعم إصدار أحدث، تسوي `git rebase` لفرعك على الإصدار المطابق.

### خطوات تبدأ فيها الحين (قبل أي كود)
1. **ألغِ `TYPESAFE_API_KEY`** من موقع الخدمة، وسوّ مفتاح جديد تحطه في متغير بيئة.
2. حدّث الاشتراكات في نسختك الحالية: `dsh plugin --profile web update --latest dsh-plugin-subscriptions`، وبعدها أعد تشغيل `dsh web` في وقت مناسب.
3. نسخة احتياطية كاملة (المرحلة 0).
4. Fork عام على GitHub، وبعدها `git checkout -b tariq/baseline-0.1.5 dsh-v0.1.5-rc.2`.

---

## 11. تحديد النطاق النهائي: مود Auto Subagents بس

**سند مستبعد كله، بنسخته القديمة والجديدة.** ومعه ما يلزم Agent Teams ولا preset `multi-agent`. شيكت ومود Auto **ما يعتمد على أي واحد منهم**: ما فيه أي إشارة لـagent-teams أو sanad داخل الإضافة أو الـpreset.

### اللي ينتقل للفورك (بس هذا)
| المكوّن | المصدر الحالي |
|---|---|
| التعديلات الـ12 على DSH | `plugins-src/dsh-auto-subagents/core-patches/` |
| الإضافة (router، المنسق، الوصفات، بطاقة التشغيل) | `plugins-src/dsh-auto-subagents/` |
| preset Auto Subagents | `.agent-presets/auto-subagents/` |
| وصفة feature-pipeline | `recipes/feature-pipeline/` (بدون `.runs`) |
| ألوان النماذج في قائمة الوكلاء (اختياري، يفيد Auto) | `local-changes/subagent-model-colors/` |
| RTL العربي (اختياري) | `profiles/web/plugins/dsh-rtl-arabic/` |

### المزودين اللي يعتمد عليهم Auto فعلًا (من `settings.yaml` → modelTiers)
| المزود | من وين يجي | الـtier |
|---|---|---|
| `claude` | **dsh-plugin-subscriptions** | strong |
| `codex` | **dsh-plugin-subscriptions** | strong |
| `xkiro` | مزود OpenAI-compatible في settings، **ما يحتاج إضافة** | strong / medium / light |
| `commandcode` | **@mars-sea/dsh-commandcode-provider** | medium |

**الإضافات الأساسية بعد التعديل:**
1. `dsh-plugin-subscriptions@0.9.7`، وهو أهمها لأنه يعطي Claude وCodex للـstrong.
2. `@mars-sea/dsh-commandcode-provider`، **بس لو تبي تبقي commandcode**. لو ما تبيه، احذفه من `modelTiers` وتستغني عن الإضافة.

### اللي ما ينتقل
`.agent-presets/sanad-team/`، و`.agent-presets/multi-agent/`، وإعدادات `agent-teams` كلها في `cordis.patch.yml` (ملفي sanad وmultiagent)، و`@nanmicoder/dsh-agent-teams`، وباقي إضافات [H] إلا لو قررت تبقي شي منها.

### قرار: commandcode يبقى
| الإضافة | على baseline `0.1.5-rc.2` | على الهدف `0.2.0-rc.2` |
|---|---|---|
| `dsh-plugin-subscriptions` | 0.9.7 | 0.9.7 |
| `@mars-sea/dsh-commandcode-provider` | **0.11.11** (المثبتة الحين) | **0.12.3** (تطلب `0.2.0-rc.2` بالضبط) |

**الإضافتين تدعمان `0.2.0-rc.2`، وهذا يأكد إنه الهدف الصح للترقية.** ولما ترقي، حدّث commandcode من 0.11.11 إلى 0.12.3 في نفس الـcommit.

---

## 12. ميزة: إدارة مفاتيح الأدوات (MCP) من الإعدادات وتخزينها مشفّرة

### الوضع الحالي (بعد ما فحصت الكود)
- مفاتيح المزودين (`DEEPSEEK_API_KEY` و`XKIRO_API_KEY`) تنحفظ من صفحة **Models** في `home/.credentials.yaml` عن طريق `dsh-credentials-local`. الإعدادات تحفظ **اسم المفتاح** بس، والقيمة تنحفظ في ملف ثاني.
- **بس الملف نفسه نص صريح غير مشفّر.** صلاحياته 0600، يعني بس مستخدم الجهاز يقدر يقراه، لكن هذا ما يعتبر تشفير. وثيقة الحزمة تقول: "an OS-keychain provider is deferred". يعني ما فيه تخزين في Keychain حاليًا.
- `dsh-mcp-client` **ما يقرا من مخزن المفاتيح أصلًا.** قيم `env` لازم تنكتب حرفيًا أو تجي من `process.env` بـ`!!js`، عشان كذا `TYPESAFE_API_KEY` مكتوب صريح في `cordis.patch.yml`.

### المطلوب (3 أجزاء في الفورك)
1. **المفاتيح تنحفظ مشفّرة: حزمة `dsh-credentials-keychain`**
   - تكون backend بديل يطبّق نفس واجهة `ctx.credentials` (resolve، describe، set، unset، records).
   - macOS: Keychain عن طريق أمر `security` أو مكتبة keytar/`@napi-rs/keyring`. وبعدين Windows Credential Manager وlibsecret على لينكس، بنفس المكتبة.
   - ملف `.credentials.yaml` يصير فيه **أسماء بس**، والقيم كلها في Keychain.
   - هجرة لمرة وحدة: تنقل القيم الموجودة من الملف إلى Keychain وتمسحها من الملف.
   - لما يصير عندك تطبيق سطح مكتب بـTauri، تستخدم نفس Keychain عن طريق plugin `keyring`.
2. **إضافة المفاتيح لـMCP: تعديل `dsh-mcp-client`**
   - نخليه يقبل مرجع لمفتاح بدل القيمة:
     ```yaml
     env:
       TYPESAFE_API_KEY: { credential: TYPESAFE_API_KEY }
     ```
   - يقرا القيمة من `ctx.credentials.resolve()` وقت تشغيل العملية بس، وما يكتبها في الإعدادات ولا في السجلات.
   - لو كان المفتاح ناقص، يعطي خطأ واضح يقول "المفتاح غير مضبوط"، ويوقف تشغيل الأداة.
3. **واجهة في الإعدادات: بطاقة "Tools / MCP"** بجنب Models
   - قائمة سيرفرات MCP، وجنب كل واحد نقطة خضراء أو حمراء مثل صفحة Models.
   - زر **Edit** يفتح حقل كلمة سر للمفتاح (`type=password`). يرسل القيمة مرة وحدة لـ`ctx.credentials.set`، **وما ترجع للمتصفح أبدًا**. الواجهة تعرض بس "مضبوط / غير مضبوط" مع المصدر، عن طريق `describe`.
   - Add / Delete للسيرفر (stdio أو HTTP).

### مرحلة التنفيذ
هذا شغل **جديد** مو جزء من نقل التعديلات. يدخل **بعد المرحلة 4** (لما يكون الأساس 0.1.5 شغال وتمر الاختبارات)، وقبل الترقية لـ0.2.0 أو بعدها. الأفضل بعد الترقية عشان ما تكتبه مرتين.
- ترتيب الشغل: (2) مراجع MCP، بعدها (3) الواجهة، بعدها (1) Keychain. لأن (1) يستبدل الـbackend بس، فكل الأجزاء الثانية تشتغل قبله على الملف.
- **كل جزء منها مرشّح Pull Request لـupstream**، لأنها تفيد كل مستخدمي DSH. وكل جزء يقبلونه يخفف عليك الصيانة.

### الحين (قبل الفورك)
- **ما يلزم تلغي المفتاح** بشرط إنه ما انرفع لأي مكان ولا شاركته مع أحد. ملفات `home/` أصلًا ما تدخل الفورك.
- **حل مؤقت آمن:** تنقل القيمة من `cordis.patch.yml` إلى `home/.env` أو متغير بيئة يتحمّل مع تشغيل `dsh web`، وتخلي السطر في الإعدادات كذا:
  `TYPESAFE_API_KEY: !!js process.env.TYPESAFE_API_KEY`
  هذا يحتاج إعادة تشغيل `dsh web`.

---

## 13. التقدم الحالي وترتيب العمل

[سجل التحقق](AUTO-V020-STATUS.md) هو المرجع الحالي لنتائج البناء والاختبارات والقبول. [فحص baseline](BASELINE.md) و[فحص توافق 0.2.0](AUTO-0.2.0-COMPATIBILITY.md) يحفظان أدلة المراحل السابقة ولا يحددان إصدار التشغيل الحالي.

| المرحلة | الحالة | الخطوة التالية |
|---|---|---|
| دمج المصدر مع 0.2.1-alpha.1 | مكتمل | تثبيت التشغيل والتحقق من الإصلاحات |
| Auto والوصفات السبع وPTC | مدمجة | إصلاح العيوب المثبتة وإعادة الاختبارات المتأثرة |
| ترحيل الإعدادات | تحويل قسم Auto متاح | إنشاء ملف مستقل من نسخة الإعدادات ومراجعته قبل تطبيقه |
| الجلسات الشخصية | غير مرحّلة | التحقق على نسخ مع الحفاظ على الملفات الأصلية |
| المزودون الخارجيون | توافقهم الحالي غير مثبت | التحقق من إصدارات تدعم 0.2.1-alpha.1 قبل تثبيتها |
| سند وAgent Teams | خارج النطاق | لا ترحيل مطلوب |
| مراجع اعتماد MCP وKeychain | وظائف إضافية غير منفذة | تُحدد بعد استقرار Auto؛ لا يلزم تنفيذها لإصلاحه |
| العربية وألوان النماذج وهوية رُبّان | مؤجلة | الواجهة آخر مرحلة بعد التشغيل والترحيل |
| التغليف والتوزيع | غير معتمد | بعد اكتمال قبول النسخة |
