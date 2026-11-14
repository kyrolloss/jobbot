// Builds the client-facing "concept page" for a freelance job.
// Design notes:
// - Works with JavaScript OFF (the Flutter WebView disables it by default):
//   tabs, accordions and the scope checklist are pure HTML/CSS.
//   JS only adds extras: live theme switch, scroll progress, spotlight, counter.
// - Fully offline: no external fonts/images. A CSP meta blocks all network calls.
// - Every dynamic string goes through sanitizeContent()/inline().

const THEMES = Object.freeze({
  classic: { background: '#edf1f7', surface: '#ffffff', ink: '#10223a', muted: '#5d6b82', accent: '#2f5bea', accent2: '#ff7a3d', on: '#ffffff' },
  modern: { background: '#14122b', surface: '#1e1b3d', ink: '#f3f1ff', muted: '#a9a6cc', accent: '#ff4f7b', accent2: '#38e1c6', on: '#14122b' },
  minimal: { background: '#f1f1ef', surface: '#fbfbfa', ink: '#1c1c1b', muted: '#66665f', accent: '#1f1f1f', accent2: '#0f9d8a', on: '#ffffff' },
});

const THEME_LABELS = Object.freeze({ classic: 'أزرق هادئ', modern: 'داكن حيوي', minimal: 'رمادي بسيط' });

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

const stripTags = (text) => String(text ?? '').replace(/<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>/g, '').trim();

export function sanitizeContent(text) {
  return escapeHtml(stripTags(text)).replace(/\r\n?|\n/g, '<br>');
}

// Single-line variant (titles, attributes, <title>).
function inline(text) {
  return escapeHtml(stripTags(text)).replace(/\s+/g, ' ').trim();
}

function clip(text, max) {
  const chars = Array.from(String(text ?? ''));
  if (chars.length <= max) return chars.join('');
  const head = chars.slice(0, max).join('');
  const cut = head.lastIndexOf(' ');
  // Cut at a word boundary when one exists reasonably close to the limit.
  return `${(cut > max * 0.6 ? head.slice(0, cut) : head).trim()}…`;
}

function displayValue(value) {
  return value === null || value === undefined || value === '' ? 'غير محدد' : String(value);
}

function categoryFor(job) {
  const text = `${job.title || ''} ${job.description || ''}`.toLowerCase();
  if (/ترجم|translation|proofread|تحرير|كتابة|محتوى|article|copywrit|writer|editor/.test(text)) return 'editorial';
  if (/تصميم|هوية|شعار|logo|brand|graphic|illustrat|ui\/ux|visual/.test(text)) return 'creative';
  if (/تسويق|marketing|campaign|social media|سوشيال|seo|sales|مبيعات|إعلان|advert/.test(text)) return 'campaign';
  if (/فيديو|مونتاج|video|reel|motion|animation|يوتيوب|youtube/.test(text)) return 'video';
  return 'service';
}

function featureItems(job, proposal) {
  const tasks = Array.isArray(job.estimated_tasks) ? job.estimated_tasks
    .map((task) => typeof task === 'string' ? task : task?.name)
    .filter((task) => typeof task === 'string' && task.trim()) : [];
  const source = tasks.length ? tasks.join('\n') : `${job.description || ''}\n${proposal || ''}`;
  const entries = source.split(/[\n.!؟?؛;]+/).map((line) => line.replace(/^[-*•\d.)\s]+/, '').trim()).filter((line) => line.length >= 8);
  const unique = [...new Set(entries)].map((line) => clip(line, 90));
  if (unique.length >= 3) return unique.slice(0, 3);
  const fallback = ['تحديد المطلوب والتفاصيل بدقة', 'إعداد نموذج أولي قابل للمراجعة', 'تطوير النتيجة حسب ملاحظاتك'];
  return [...unique, ...fallback].slice(0, 3);
}

const CATEGORY = Object.freeze({
  editorial: {
    label: 'محتوى وتحرير',
    preview: 'من المسودة إلى النص الجاهز',
    tagline: 'نص يُقرأ بسلاسة ويصل إلى الجمهور الذي كتبته له.',
    how: [
      'نبدأ بفهم الجمهور والنبرة قبل كتابة أي سطر، ثم نثبّت مصطلحات العمل.',
      'تصلك مسودة أولى للمراجعة، وكل ملاحظة تُحسب في النسخة التالية.',
      'قراءة أخيرة للاتساق والإملاء قبل التسليم.',
    ],
    addons: ['مراجعة لغوية إضافية', 'نسخة بصيغة مختلفة', 'ملخص في صفحة واحدة'],
  },
  creative: {
    label: 'تصميم وهوية',
    preview: 'اختر اتجاهاً بصرياً',
    tagline: 'هوية تعبّر عن مشروعك قبل أن يقرأ أحد كلمة واحدة.',
    how: [
      'نجمع مراجعك وما يعجبك وما لا يعجبك، ونحوّلها إلى لوحة اتجاه واضحة.',
      'نعرض لك اتجاهات محددة بدل خيارات كثيرة مشتتة، ثم نعمّق ما تختاره.',
      'نسلّم الملفات بصيغ جاهزة للاستخدام مع شرح مختصر لطريقة تطبيقها.',
    ],
    addons: ['ملف مصدر قابل للتعديل', 'دليل استخدام مختصر', 'نسخ للوسائل المختلفة'],
  },
  campaign: {
    label: 'تسويق وحملات',
    preview: 'شكل الحملة على كل قناة',
    tagline: 'رسالة واحدة واضحة، تتشكل بما يناسب كل منصة.',
    how: [
      'نحدد الجمهور والهدف والرسالة الأساسية قبل صياغة المحتوى.',
      'نجهّز محتوى لكل قناة بنبرة العلامة، مع تقويم نشر تراجعه معنا.',
      'نتابع ما نجح ونعدّل عليه بدل البدء من الصفر.',
    ],
    addons: ['تقويم نشر لشهر كامل', 'صياغات بديلة للعناوين', 'تقرير مختصر بعد التنفيذ'],
  },
  video: {
    label: 'فيديو وحركة',
    preview: 'مشاهد العمل بالتسلسل',
    tagline: 'فكرتك مشاهد متتابعة، يمكنك أن تراها قبل التصوير أو المونتاج.',
    how: [
      'نكتب تسلسل المشاهد ونراجعه معك قبل أي إنتاج.',
      'نعرض لك لقطة أولية للإيقاع والانتقالات لتعتمد الاتجاه.',
      'نسلّم المقطع بالمقاسات المتفق عليها بعد جولة مراجعة.',
    ],
    addons: ['نسخة بمقاس عمودي', 'ترجمة نصية للمقطع', 'صورة غلاف'],
  },
  service: {
    label: 'خدمة احترافية',
    preview: 'رحلة العمل خطوة بخطوة',
    tagline: 'تصور واضح لما ستستلمه، قبل أن يبدأ العمل الفعلي.',
    how: [
      'نحوّل طلبك إلى نقاط محددة نتفق عليها، فلا يبقى شيء ضمنياً.',
      'نعرض لك نموذجاً أولياً تعدّل عليه قبل تثبيت التفاصيل.',
      'نسلّم النتيجة مع شرح موجز، ونبقى متاحين لتوضيح أي نقطة.',
    ],
    addons: ['جلسة متابعة بعد التسليم', 'توثيق مختصر', 'خطوة تجريبية قبل الاعتماد'],
  },
});

/* ---------- interactive previews (pure HTML/CSS tabs) ---------- */

function tabs(id, labels, panels) {
  const radios = labels.map((_, i) => `<input type="radio" name="${id}" id="${id}-${i}"${i === 0 ? ' checked' : ''}>`).join('');
  const bar = labels.map((label, i) => `<label for="${id}-${i}">${label}</label>`).join('');
  const body = panels.map((panel) => `<div class="panel">${panel}</div>`).join('');
  return `<div class="tabs">${radios}<div class="tabbar">${bar}</div><div class="panels">${body}</div></div>`;
}

function editorialPreview(t) {
  const meter = (label, v) => `<span>${label}</span><span class="track"><b style="--v:${v}%"></b></span>`;
  return tabs('pv', ['مسودة', 'مراجعة', 'جاهز'], [
    `<div class="paper"><small class="tag">المسودة الأولى</small><h4>${t}</h4><i class="ln"></i><i class="ln w90"></i><i class="ln w70"></i><i class="ln"></i><i class="ln w45"></i></div>`,
    `<div class="paper"><small class="tag">المراجعة</small><h4>${t}</h4><i class="ln"></i><i class="ln hl w90"></i><span class="note">جملة طويلة، نقترح تقسيمها</span><i class="ln w70"></i><i class="ln hl"></i><span class="note alt">وحّدنا المصطلح في النص كله</span></div>`,
    `<div class="paper"><small class="tag">النسخة النهائية</small><h4>${t}</h4><i class="ln"></i><i class="ln w90"></i><i class="ln w70"></i><div class="meter">${meter('اتساق اللغة', 94)}${meter('وضوح الرسالة', 88)}${meter('مناسبة الجمهور', 96)}</div><span class="stamp">جاهز للنشر</span></div>`,
  ]);
}

function creativePreview(t) {
  const dirs = [
    { name: 'هادئ وموثوق', c1: '#2b4a6f', c2: '#8fb8c9', c3: '#e8eef2', ci: '#ffffff', f: 'serif' },
    { name: 'جريء ومباشر', c1: '#e63946', c2: '#1d1d2b', c3: '#f1f3f5', ci: '#ffffff', f: 'heavy' },
    { name: 'حيوي ومرح', c1: '#7b2ff7', c2: '#00c2a8', c3: '#f9c80e', ci: '#ffffff', f: 'round' },
  ];
  return tabs('pv', dirs.map((d) => d.name.split(' ')[0]), dirs.map((d) => `<div class="canvas" style="--c1:${d.c1};--c2:${d.c2};--ci:${d.ci}"><span class="ring"></span><small>${d.name}</small><strong class="logo ${d.f}">${t}</strong></div><div class="sw"><i style="background:${d.c1}"></i><i style="background:${d.c2}"></i><i style="background:${d.c3}"></i><span>اللوحة اللونية للاتجاه</span></div>`));
}

function campaignPreview(t) {
  const head = '<div class="ph"><i class="av"></i><div><b>اسم العلامة</b><small>منشور تعريفي</small></div></div>';
  return tabs('pv', ['إنستغرام', 'لينكدإن', 'بريد'], [
    `<div class="post">${head}<div class="img sq"><strong>${t}</strong></div><i class="ln"></i><i class="ln w70"></i><div class="react"><span>إعجاب</span><span>تعليق</span><span>مشاركة</span></div></div>`,
    `<div class="post">${head}<p class="cap"><b>${t}</b></p><i class="ln"></i><i class="ln w90"></i><i class="ln w70"></i><div class="img wide"></div><div class="react"><span>أعجبني</span><span>تعليق</span></div></div>`,
    `<div class="post"><div class="subject"><small>الموضوع</small><b>${t}</b></div><i class="ln"></i><i class="ln w90"></i><i class="ln w70"></i><i class="ln w45"></i><span class="fakebtn">اطلب الآن</span></div>`,
  ]);
}

function videoPreview(t) {
  const tl = '<div class="tl"><i></i><i></i><i></i><i></i><i></i><i></i><em class="play"></em></div>';
  return tabs('pv', ['الافتتاح', 'الفكرة', 'الختام'], [
    `<div class="screen s1"><i class="sun"></i><i class="hill"></i><span class="cap2">${t}</span></div>${tl}`,
    `<div class="screen s2"><i class="bar b1"></i><i class="bar b2"></i><i class="bar b3"></i><i class="bar b4"></i><i class="bar b5"></i><span class="cap2">الفكرة الأساسية في ثوانٍ</span></div>${tl}`,
    `<div class="screen s3"><i class="orb"></i><i class="orb o2"></i><span class="cap2">دعوة واضحة للخطوة التالية</span></div>${tl}`,
  ]);
}

function servicePreview(t) {
  return tabs('pv', ['الطلب', 'التنفيذ', 'النتيجة'], [
    `<div class="app"><small class="tag">طلب جديد</small><h4>${t}</h4><div class="field"><i class="ln w45"></i><span></span></div><div class="field"><i class="ln w70"></i><span></span></div><span class="fakebtn">ابدأ العمل</span></div>`,
    `<div class="app"><small class="tag">جارٍ التنفيذ</small><h4>نرتّب المطلوب</h4><div class="prog"><b></b></div><ul class="steps"><li class="done">فهم التفاصيل</li><li class="done">إعداد النموذج</li><li>مراجعة معك</li></ul></div>`,
    `<div class="app"><small class="tag">جاهز للمراجعة</small><div class="okrow"><span class="ok">✓</span><h4>${t}</h4></div><div class="rowk"><span>المطلوب</span><b>مكتمل</b></div><div class="rowk"><span>الملاحظات</span><b>مفتوحة لك</b></div><div class="rowk"><span>الخطوة التالية</span><b>اعتماد أو تعديل</b></div></div>`,
  ]);
}

function previewFor(category, t) {
  if (category === 'editorial') return editorialPreview(t);
  if (category === 'creative') return creativePreview(t);
  if (category === 'campaign') return campaignPreview(t);
  if (category === 'video') return videoPreview(t);
  return servicePreview(t);
}

/* ---------- styles ---------- */

function styles() {
  const themeVars = Object.entries(THEMES).map(([key, c]) => `html[data-theme="${key}"]{--bg:${c.background};--surface:${c.surface};--ink:${c.ink};--muted:${c.muted};--accent:${c.accent};--accent2:${c.accent2};--on:${c.on};--font:${key === 'minimal' ? '"Noto Naskh Arabic","Amiri","Times New Roman",serif' : '"Noto Kufi Arabic","Segoe UI",Tahoma,system-ui,sans-serif'};color-scheme:${key === 'modern' ? 'dark' : 'light'}}`).join('\n');
  const tabRules = [1, 2, 3].map((i) => `.tabs>input:nth-of-type(${i}):checked~.tabbar label:nth-child(${i}){background:var(--surface);color:var(--ink);box-shadow:0 2px 8px color-mix(in srgb,var(--ink) 14%,transparent)}.tabs>input:nth-of-type(${i}):checked~.panels>.panel:nth-child(${i}){display:block;animation:swap .35s ease}.tabs>input:nth-of-type(${i}):focus-visible~.tabbar label:nth-child(${i}){outline:2px solid var(--accent);outline-offset:2px}`).join('\n');
  return `${themeVars}
:root{--line:color-mix(in srgb,var(--ink) 12%,transparent);--soft:color-mix(in srgb,var(--accent) 9%,var(--surface))}
*{box-sizing:border-box;margin:0}
html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}
body{background:var(--bg);color:var(--ink);font:400 16px/1.8 var(--font);overflow-x:hidden;transition:background .4s,color .4s}
a{color:inherit}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.progress{position:fixed;top:0;inset-inline:0;height:3px;z-index:50;transform-origin:right;transform:scaleX(var(--p,0));background:linear-gradient(90deg,var(--accent),var(--accent2))}
.aura{position:fixed;inset:0;z-index:-1;overflow:hidden;pointer-events:none}
.aura i{position:absolute;border-radius:50%;filter:blur(90px);opacity:.26}
.aura i:first-child{width:420px;height:420px;background:var(--accent);top:-160px;right:-120px}
.aura i:last-child{width:380px;height:380px;background:var(--accent2);bottom:-160px;left:-140px}
.wrap{max-width:1120px;margin:auto;padding:0 20px}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 0}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;text-decoration:none}
.mark{width:34px;height:34px;border-radius:11px;display:grid;place-items:center;background:var(--accent);color:var(--on);font-weight:800}
.dots{display:none;align-items:center;gap:8px;font-size:13px;color:var(--muted)}
.js .dots{display:flex}
.dots button{width:22px;height:22px;border-radius:50%;border:2px solid var(--surface);cursor:pointer;padding:0}
.dots button[aria-pressed="true"]{outline:2px solid var(--accent);outline-offset:2px}
.hero{position:relative;display:grid;gap:34px;padding:26px 0 52px}
.hero::before{content:"";position:absolute;inset:-40px -20px;z-index:-1;pointer-events:none;background:radial-gradient(420px circle at var(--mx,75%) var(--my,25%),color-mix(in srgb,var(--accent) 16%,transparent),transparent 70%)}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px}
.chip{padding:3px 12px;border:1px solid var(--line);border-radius:99px;font-size:13px;color:var(--muted);background:var(--surface)}
h1{font-size:clamp(30px,6.6vw,56px);line-height:1.3;font-weight:800;margin-bottom:16px}
.w{display:inline-block;animation:rise .7s cubic-bezier(.2,.7,.2,1) both;animation-delay:calc(var(--i)*60ms)}
.lead{color:var(--muted);font-size:17px;max-width:52ch}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:24px}
.btn{display:inline-flex;align-items:center;justify-content:center;padding:12px 22px;border-radius:12px;font:700 15px var(--font);cursor:pointer;border:1px solid transparent;text-decoration:none;transition:transform .2s}
.btn:hover{transform:translateY(-2px)}
.btn.main{background:var(--accent);color:var(--on)}
.btn.ghost{border-color:var(--line);background:transparent;color:var(--ink)}
.note-line{font-size:13px;color:var(--muted);margin-top:14px}
.stage{background:var(--surface);border:1px solid var(--line);border-radius:22px;padding:12px;box-shadow:0 30px 60px -30px color-mix(in srgb,var(--ink) 40%,transparent)}
.stage-head{display:flex;align-items:center;gap:6px;padding:4px 6px 10px;font-size:12px;color:var(--muted)}
.stage-head i{width:8px;height:8px;border-radius:50%;background:var(--line)}
.stage-head span{margin-inline-start:auto}
.hint{font-size:13px;color:var(--muted);margin:10px 6px 2px;text-align:center}
.tabs{position:relative}
.tabs>input{position:absolute;opacity:0;pointer-events:none}
.tabbar{display:flex;gap:4px;padding:4px;background:var(--soft);border-radius:12px;margin-bottom:10px}
.tabbar label{flex:1;text-align:center;padding:7px 4px;border-radius:9px;font-size:13px;font-weight:700;cursor:pointer;color:var(--muted);transition:background .2s,color .2s}
.panels>.panel{display:none}
${tabRules}
.tag{color:var(--accent);font-weight:700;font-size:12px}
.ln{display:block;height:7px;border-radius:4px;background:var(--line);margin:11px 0}
.w90{width:90%}.w70{width:70%}.w45{width:45%}
.paper,.app,.post{background:var(--bg);border-radius:14px;padding:18px;min-height:250px;position:relative}
.paper h4,.app h4{font-size:17px;line-height:1.5;margin:4px 0 12px}
.ln.hl{background:color-mix(in srgb,var(--accent2) 50%,transparent)}
.note{display:inline-block;background:var(--accent);color:var(--on);font-size:12px;padding:4px 10px;border-radius:10px;margin:2px 0}
.note.alt{background:var(--accent2);color:#0b1020}
.stamp{position:absolute;left:14px;bottom:14px;border:2px solid var(--accent2);color:var(--accent2);padding:2px 12px;border-radius:8px;font-weight:800;font-size:13px;transform:rotate(-6deg)}
.meter{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-size:12px;color:var(--muted);align-items:center;margin-top:14px;max-width:70%}
.track{height:6px;border-radius:4px;background:var(--line);overflow:hidden}
.track b{display:block;height:100%;width:var(--v);background:linear-gradient(90deg,var(--accent2),var(--accent))}
.canvas{position:relative;overflow:hidden;border-radius:14px;min-height:210px;padding:20px;background:linear-gradient(135deg,var(--c1),var(--c2));color:var(--ci);display:flex;flex-direction:column;justify-content:flex-end;gap:6px}
.canvas small{font-size:12px;opacity:.85}
.logo{font-size:26px;line-height:1.3}
.logo.serif{font-family:Georgia,"Times New Roman",serif;font-weight:400}
.logo.heavy{font-weight:900}
.logo.round{font-weight:700;border:2px solid var(--ci);border-radius:99px;padding:4px 16px;align-self:flex-start}
.ring{position:absolute;width:150px;height:150px;border-radius:50%;border:1px solid var(--ci);opacity:.35;top:-40px;left:-30px;box-shadow:0 0 0 20px color-mix(in srgb,var(--ci) 8%,transparent)}
.sw{display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12px;color:var(--muted)}
.sw i{width:26px;height:26px;border-radius:8px;border:1px solid var(--line)}
.sw span{margin-inline-start:auto}
.ph{display:flex;align-items:center;gap:10px;font-size:13px}
.ph small{display:block;color:var(--muted)}
.av{width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent2))}
.img{display:grid;place-items:center;text-align:center;border-radius:10px;margin:12px 0;padding:12px;background:linear-gradient(120deg,var(--accent),var(--accent2));color:var(--on)}
.img.sq{min-height:130px}.img.wide{min-height:70px}
.cap{margin:12px 0 4px}
.react{display:flex;gap:16px;margin-top:12px;font-size:12px;color:var(--muted)}
.subject{border-bottom:1px solid var(--line);padding-bottom:10px;margin-bottom:6px}
.subject small{display:block;color:var(--muted);font-size:12px}
.fakebtn{display:inline-block;margin-top:14px;padding:7px 18px;border-radius:9px;background:var(--accent);color:var(--on);font-size:13px;font-weight:700}
.screen{position:relative;height:170px;border-radius:13px;overflow:hidden}
.s1{background:linear-gradient(150deg,#241d4e,#141a32 55%,#326d76)}
.s2{background:linear-gradient(150deg,#12263a,#1d4e6b)}
.s3{background:linear-gradient(150deg,#3b1b5a,#e0527a)}
.sun{position:absolute;width:64px;height:64px;border-radius:50%;background:#f5c875;top:26px;right:50px}
.hill{position:absolute;inset:auto -10% -60px;height:150px;background:#3f8275;clip-path:polygon(0 62%,30% 15%,50% 52%,70% 22%,100% 67%,100% 100%,0 100%)}
.bar{position:absolute;bottom:0;width:13%;background:rgba(255,255,255,.22);border-radius:6px 6px 0 0}
.b1{right:8%;height:55%}.b2{right:24%;height:80%}.b3{right:40%;height:45%}.b4{right:56%;height:68%}.b5{right:72%;height:35%}
.orb{position:absolute;width:110px;height:110px;border-radius:50%;border:2px solid rgba(255,255,255,.5);top:24px;left:40px}
.orb.o2{width:60px;height:60px;top:70px;left:92px;background:rgba(255,255,255,.2)}
.cap2{position:absolute;bottom:10px;right:12px;left:12px;color:#fff;font-size:13px;font-weight:700;text-shadow:0 2px 6px rgba(0,0,0,.5)}
.tl{position:relative;display:flex;gap:3px;padding:6px;margin-top:10px;background:var(--bg);border-radius:9px;overflow:hidden}
.tl i{flex:1;height:22px;border-radius:5px;background:color-mix(in srgb,var(--accent) 55%,var(--surface))}
.tl i:nth-child(even){background:color-mix(in srgb,var(--accent2) 55%,var(--surface))}
.play{position:absolute;top:0;bottom:0;width:2px;background:var(--ink);animation:scrub 6s linear infinite}
.field{display:flex;flex-direction:column;gap:4px;margin:12px 0}
.field span{height:34px;border:1px solid var(--line);border-radius:9px;background:var(--surface)}
.prog{height:8px;border-radius:5px;background:var(--line);overflow:hidden;margin:6px 0 14px}
.prog b{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--accent2),var(--accent));animation:fill 2.4s ease forwards}
.steps{list-style:none;padding:0;font-size:14px;color:var(--muted)}
.steps li{padding:3px 0 3px 0}
.steps li::before{content:"○";margin-inline-end:8px}
.steps li.done{color:var(--ink)}
.steps li.done::before{content:"●";color:var(--accent2)}
.okrow{display:flex;align-items:center;gap:10px}
.ok{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;background:var(--accent2);color:#0b1020;font-weight:800;flex:none}
.rowk{display:flex;justify-content:space-between;padding:9px 0;border-top:1px solid var(--line);font-size:14px}
.rowk span{color:var(--muted)}
.sec{padding:52px 0}
.sec h2{font-size:clamp(24px,4vw,34px);line-height:1.35;font-weight:800;margin-bottom:10px}
.sub{color:var(--muted);max-width:58ch;margin-bottom:24px}
.card{border:1px solid var(--line);background:var(--surface);border-radius:14px;margin-bottom:10px}
.card summary{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 18px;cursor:pointer;font-weight:700;list-style:none}
.card summary::-webkit-details-marker{display:none}
.card summary::after{content:"+";font-size:22px;line-height:1;color:var(--accent);transition:transform .25s}
.card[open] summary::after{transform:rotate(45deg)}
.card .body{padding:0 18px 16px;color:var(--muted)}
.split{display:grid;gap:26px}
.pick{display:flex;align-items:center;gap:12px;padding:13px 16px;border:1px solid var(--line);border-radius:14px;background:var(--surface);cursor:pointer;margin-bottom:8px;position:relative}
.pick input{position:absolute;opacity:0}
.tick{width:22px;height:22px;border-radius:7px;border:2px solid var(--line);display:grid;place-items:center;flex:none;transition:background .2s,border-color .2s}
.pick input:checked+.tick{background:var(--accent);border-color:var(--accent)}
.pick input:checked+.tick::after{content:"✓";color:var(--on);font-size:13px;line-height:1}
.pick input:checked~.ptxt{font-weight:700}
.pick input:focus-visible+.tick{outline:2px solid var(--accent);outline-offset:2px}
.pick small{margin-inline-start:auto;color:var(--muted);font-size:12px;flex:none}
.sum{border:1px solid var(--line);border-radius:18px;padding:20px;background:var(--soft);align-self:start}
.sum strong{font-size:40px;line-height:1.1}
.meterbar{height:8px;border-radius:5px;background:var(--line);overflow:hidden;margin:12px 0}
.meterbar b{display:block;height:100%;width:var(--f,50%);background:linear-gradient(90deg,var(--accent2),var(--accent));transition:width .4s}
.sum p{color:var(--muted);font-size:14px}
.road{position:relative;padding-inline-start:46px;--rp:1}
.road::before,.road::after{content:"";position:absolute;inset-inline-start:15px;top:6px;bottom:30px;width:2px;background:var(--line)}
.road::after{background:var(--accent);transform-origin:top;transform:scaleY(var(--rp))}
.rs{position:relative;padding-bottom:26px}
.rs .n{position:absolute;inset-inline-start:-46px;top:0;width:32px;height:32px;border-radius:50%;background:var(--surface);border:2px solid var(--accent);display:grid;place-items:center;font-size:14px;font-weight:800;z-index:1}
.rs h3{font-size:18px;margin-bottom:2px}
.rs p{color:var(--muted)}
.rs .you{display:inline-block;margin-top:6px;font-size:13px;padding:2px 12px;border-radius:8px;background:var(--soft)}
.stats{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(230px,1fr))}
.stat{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:20px}
.stat strong{display:block;font-size:34px;line-height:1.3}
.stat span{color:var(--muted);font-size:14px}
.quote{border-inline-start:3px solid var(--accent);padding:4px 18px;font-size:17px;line-height:2;max-width:64ch}
.sig{margin-top:12px;color:var(--muted);font-size:14px}
.cta{border-radius:24px;padding:36px 26px;background:var(--ink);color:var(--bg);display:grid;gap:14px}
.cta h2{font-size:clamp(24px,4vw,34px);line-height:1.35;margin:0}
.cta p{opacity:.8;max-width:52ch}
.cta .btn.main{background:var(--accent2);color:#0b1020;justify-self:start}
.foot{text-align:center;color:var(--muted);font-size:12px;padding:26px 0 40px}
.js .rv{opacity:0;transform:translateY(14px);transition:opacity .6s ease,transform .6s ease}
.js .rv.in{opacity:1;transform:none}
@keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
@keyframes swap{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes fill{to{width:78%}}
@keyframes scrub{from{right:0}to{right:100%}}
@media(min-width:860px){
.hero{grid-template-columns:1fr 1.05fr;align-items:center;padding:54px 0 70px}
.split{grid-template-columns:1.4fr 1fr}
.cta{grid-template-columns:1fr auto;align-items:center;padding:44px}
.cta .btn.main{justify-self:end}
}
@media(prefers-reduced-motion:reduce){
html{scroll-behavior:auto}
*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}
.js .rv{opacity:1;transform:none}
}`;
}

const SCRIPT = `(function(){try{
var d=document,h=d.documentElement;h.classList.add('js');
var q=function(s){return Array.prototype.slice.call(d.querySelectorAll(s))};
q('[data-scroll]').forEach(function(a){a.addEventListener('click',function(e){var t=d.getElementById(a.getAttribute('data-scroll'));if(t){e.preventDefault();t.scrollIntoView({behavior:'smooth',block:'start'})}})});
q('[data-set-theme]').forEach(function(b){b.addEventListener('click',function(){h.setAttribute('data-theme',b.getAttribute('data-set-theme'));q('[data-set-theme]').forEach(function(x){x.setAttribute('aria-pressed',String(x===b))})})});
var bar=d.querySelector('.progress'),road=d.querySelector('.road');
function onScroll(){var y=window.pageYOffset||h.scrollTop,m=h.scrollHeight-h.clientHeight;if(bar&&m>0)bar.style.setProperty('--p',String(Math.min(1,y/m)));
if(road){var r=road.getBoundingClientRect(),f=(h.clientHeight*0.65-r.top)/r.height;road.style.setProperty('--rp',String(Math.max(0,Math.min(1,f))))}}
window.addEventListener('scroll',onScroll,{passive:true});onScroll();
var hero=d.querySelector('.hero');
if(hero){hero.addEventListener('pointermove',function(e){var r=hero.getBoundingClientRect();hero.style.setProperty('--mx',(e.clientX-r.left)+'px');hero.style.setProperty('--my',(e.clientY-r.top)+'px')})}
var boxes=q('.pick input'),cnt=d.getElementById('cnt'),fill=d.querySelector('.meterbar b'),msg=d.getElementById('scopemsg');
function upd(){var n=boxes.filter(function(b){return b.checked}).length;
if(cnt)cnt.textContent=String(n);
if(fill)fill.style.setProperty('--f',(boxes.length?n/boxes.length*100:0)+'%');
if(msg)msg.textContent=n===0?'اختر عنصراً واحداً على الأقل لنبدأ النقاش.':(n===boxes.length?'نطاق كامل، سنرتّب الأولويات معاً.':'نطاق مرن، يمكن إضافة أو حذف أي عنصر لاحقاً.')}
boxes.forEach(function(b){b.addEventListener('change',upd)});upd();
var rv=q('.rv');
if('IntersectionObserver' in window){var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target)}})},{threshold:.08});rv.forEach(function(n){io.observe(n)})}
else{rv.forEach(function(n){n.classList.add('in')})}
}catch(e){document.documentElement.classList.remove('js')}})();`;

/* ---------- page ---------- */

export function buildPrototype(job = {}, proposal = '', options = {}) {
  const theme = Object.hasOwn(THEMES, options.theme) ? options.theme : 'classic';
  const category = categoryFor(job);
  const meta = CATEGORY[category];
  const features = featureItems(job, proposal);

  const title = inline(job.title || 'فكرة مشروعك، بشكل أوضح');
  // Per-word animation only for Arabic titles; Latin titles stay one run so bidi order is preserved.
  const words = /[\u0600-\u06FF]/.test(title)
    ? title.split(' ').map((word, i) => `<span class="w" style="--i:${i}">${word}</span>`).join(' ')
    : `<span class="w" style="--i:0">${title}</span>`;
  const summaryRaw = stripTags(job.description).replace(/\s+/g, ' ');
  const heroText = clip(summaryRaw, 260) || 'تصور بصري أولي يوضح اتجاه التنفيذ، ويمكن تطويره مع تفاصيل المشروع وملاحظاتك.';
  const understood = clip(summaryRaw, 520);
  const source = job.source || job.platform;

  const chips = [meta.label, source ? `المصدر: ${inline(source)}` : '', 'نموذج أولي للنقاش'].filter(Boolean).map((c) => `<span class="chip">${c}</span>`).join('');

  const featureCards = features.map((item, i) => `<details class="card"${i === 0 ? ' open' : ''}><summary>${inline(item)}</summary><div class="body">${meta.how[i]}</div></details>`).join('');

  const scopeItems = [
    ...features.map((item) => ({ text: inline(item), tag: 'أساسي', on: true })),
    ...meta.addons.map((text) => ({ text, tag: 'اختياري', on: false })),
  ];
  const picks = scopeItems.map((s) => `<label class="pick"><input type="checkbox"${s.on ? ' checked' : ''}><span class="tick"></span><span class="ptxt">${s.text}</span><small>${s.tag}</small></label>`).join('');
  const startFill = Math.round((features.length / scopeItems.length) * 100);

  const stats = [];
  if (options.include_price === true) {
    stats.push(`<div class="stat"><span>ميزانية مبدئية</span><strong>${sanitizeContent(displayValue(job.estimated_price))}${job.currency ? ` ${sanitizeContent(job.currency)}` : ''}</strong><span>قابلة للمراجعة بعد الاتفاق على النطاق.</span></div>`);
  }
  if (options.include_timing === true) {
    stats.push(`<div class="stat"><span>المدة المتوقعة</span><strong>${sanitizeContent(displayValue(job.estimated_days))}${job.estimated_days ? ' يوم' : ''}</strong><span>تقدير أولي يتغير مع النطاق والمراجعات.</span></div>`);
  }
  const statsSection = stats.length
    ? `<section class="sec rv"><h2>الميزانية والمدة</h2><p class="sub">أرقام أولية لنبدأ بها الحديث، وليست التزاماً نهائياً.</p><div class="stats">${stats.join('')}</div></section>`
    : '';

  const proposalText = clip(stripTags(proposal).replace(/\s+/g, ' '), 420);
  const quoteSection = proposalText
    ? `<section class="sec rv"><h2>من عرضي لك</h2><p class="sub">هذا ما كتبته لك في العرض، نضعه هنا بجانب التصور.</p><blockquote class="quote" dir="auto">${escapeHtml(proposalText)}</blockquote></section>`
    : '';

  const steps = [
    ['نتفاهم على التفاصيل', 'نراجع المطلوب والأولويات ونجيب عن الأسئلة المفتوحة.', 'تؤكد ما فهمناه أو تصححه.'],
    ['نعتمد الاتجاه', 'تراجع هذا التصور ونعدّل الشكل أو المحتوى على ملاحظاتك.', 'تختار ما يناسبك وتحذف ما لا يناسبك.'],
    ['ننفّذ', 'نعمل على النطاق المتفق عليه ونشاركك التقدم أثناء العمل.', 'ترد على نقاط المراجعة في وقتها.'],
    ['نسلّم ونراجع', 'تستلم النتيجة ونغلق ملاحظاتك الأخيرة.', 'تعتمد النسخة النهائية.'],
  ].map(([h3, p, you], i) => `<div class="rs"><span class="n">${['١', '٢', '٣', '٤'][i]}</span><h3>${h3}</h3><p>${p}</p><span class="you">دورك: ${you}</span></div>`).join('');

  const faq = [
    ['هل هذا التصور هو النتيجة النهائية؟', 'لا. هو نموذج بصري للنقاش، يوضح الاتجاه حتى نتفق عليه قبل التنفيذ.'],
    ['هل أستطيع تغيير النطاق بعد الاتفاق؟', 'نعم، يمكن إضافة عناصر أو حذفها، ونعيد الاتفاق على الميزانية والمدة إن تغيّر شيء.'],
    ['كيف نبدأ؟', 'تراجع التصور وتخبرني بملاحظاتك، ثم نثبّت التفاصيل ونبدأ.'],
  ].map(([qn, an]) => `<details class="card"><summary>${qn}</summary><div class="body">${an}</div></details>`).join('');

  const dots = Object.entries(THEMES).map(([key, c]) => `<button type="button" data-set-theme="${key}" aria-label="${THEME_LABELS[key]}" aria-pressed="${key === theme}" style="background:linear-gradient(135deg,${c.accent} 50%,${c.background} 50%)"></button>`).join('');
  const generatedAt = new Date().toISOString().slice(0, 10);

  return `<!doctype html><html lang="ar" dir="rtl" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:"><meta name="description" content="تصور أولي لمشروع مستقل"><title>${title || 'تصور أولي للمشروع'}</title><style>${styles()}</style></head><body><div class="progress"></div><div class="aura"><i></i><i></i></div><div class="wrap" id="top">
<header class="topbar"><a class="brand" href="#top" data-scroll="top"><span class="mark">J</span><span>تصور مشروعك</span></a><div class="dots"><span>جرّب مظهراً آخر</span>${dots}</div></header>
<section class="hero"><div><div class="chips">${chips}</div><h1 dir="auto">${words}</h1><p class="lead" dir="auto">${escapeHtml(heroText)}</p><p class="lead" style="margin-top:8px">${meta.tagline}</p><div class="actions"><a class="btn main" href="#scope" data-scroll="scope">ابنِ نطاق العمل</a><a class="btn ghost" href="#details" data-scroll="details">كيف سننفذه</a></div><p class="note-line">نموذج بصري للمناقشة، وليس منتجاً مكتملاً أو نتيجة منفذة.</p></div>
<div><div class="stage"><div class="stage-head"><i></i><i></i><i></i><span>${meta.preview}</span></div>${previewFor(category, title)}</div><p class="hint">اضغط على التبويبات لتستعرض التصور</p></div></section>
<section class="sec rv" id="details"><h2>كما فهمنا مشروعك</h2><p class="sub" dir="auto">${understood ? escapeHtml(understood) : 'نلخّص هنا ما فهمناه من طلبك، وتصحّحه إن لزم.'}</p>${featureCards}</section>
<section class="sec rv" id="scope"><div class="split"><div><h2>ابنِ نطاق العمل بنفسك</h2><p class="sub">العناصر الأساسية مختارة، وعليك فقط أن تضيف ما يهمك. الاختيار هنا للنقاش ولا يُرسل لأي جهة.</p>${picks}</div><aside class="sum"><small>عناصر مختارة</small><div><strong id="cnt">${features.length}</strong> من ${scopeItems.length}</div><div class="meterbar"><b style="--f:${startFill}%"></b></div><p id="scopemsg">نطاق مرن، يمكن إضافة أو حذف أي عنصر لاحقاً.</p></aside></div></section>
<section class="sec rv"><h2>من الاتفاق إلى التسليم</h2><p class="sub">أربع خطوات واضحة، ولكل خطوة دور لك ودور لي.</p><div class="road">${steps}</div></section>
${statsSection}${quoteSection}
<section class="sec rv"><h2>أسئلة قد تخطر لك</h2><p class="sub">إجابات قصيرة قبل أن نبدأ.</p>${faq}</section>
<section class="rv"><div class="cta"><div><h2>جاهز نطوّر هذا التصور معاً؟</h2><p>راجع النطاق وأخبرني بملاحظاتك، ثم نثبّت التفاصيل ونبدأ.</p></div><a class="btn main" href="#top" data-scroll="top">العودة إلى البداية</a></div></section>
<p class="foot">تصور أولي مولّد للمناقشة، ${generatedAt}</p></div><script>${SCRIPT}</script></body></html>`;
}