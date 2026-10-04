# Baseline: dsh-v0.1.5-rc.2 مبني من المصدر (3 أكتوبر)

## البيئة
macOS arm64 · Node v24.21.0 · pnpm 11.7.0 (corepack) · المرجع `dsh-v0.1.5-rc.2`

## النتائج
| الفحص | النتيجة |
|---|---|
| `pnpm install` | ✅ (1m47s) |
| `pnpm run build` | ✅ (1m09s, 234 client artifacts) |
| **مطابقة 13 ملف للنسخة المنشورة على npm** | ✅ **11 متطابقة byte-for-byte**. وملفين client (`ui-settings-plugins`، `ui-subagent`) متطابقين بعد توحيد مسار البناء والـhash حق CSS module اللي ينحسب من المسار المطلق. **يعني المصدر = النسخة المثبتة.** |
| `pnpm run test` | 21886 ✅ · 248 ❌ · 129 تخطي. **كل الفشل سببه البيئة**، والتفاصيل تحت |
| اختبارات `tariq/packages/auto-subagents` (v0.2.1) | ✅ 260/260 |

## سبب الـ248 فشل (ما لها علاقة بالتعديلات)
| العدد | الملف | السبب |
|---|---|---|
| 244 | `experimental/code-runtime-python/*` | `/usr/bin/python3` = 3.9.6، والمطلوب ≥ 3.10. الحل: `brew install python@3.12` |
| 2 | `boot/app-boot/tests/hmr-config.spec.ts` | توقيت مراقبة الملفات في macOS (timeout) |
| 1 | `scripts/browser-bundled-externals.spec.ts` | مسار `/private/var/folders` المؤقت في macOS |
| 1 | `experimental/webworker-runtime/.../transform-corpus.spec.ts` | استيراد `.css` تحت Node، ويعتمد على البيئة |

**المرجع للمقارنة بعد كل تعديل:** نفس هذي الـ248 بالضبط ولا فشل زيادة.

## ملاحظة
الإضافة الأصلية في `~/.local/share/deepseek-harness/home/plugins-src/dsh-auto-subagents` **لسا تتطور** (0.2.0 صارت 0.2.1 أثناء النسخ). المصدر المعتمد للإضافة صار `tariq/packages/auto-subagents`. ولو تعدّل الأصل، نزامن بـ`rsync` قبل ما نوقف التطوير هناك.
