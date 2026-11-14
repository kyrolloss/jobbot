// Client-facing "concept page" for a freelance job (display only: the client picks nothing).
//
// - Bilingual (ar/en). The language switch is pure CSS (radio inputs), so it works
//   even with JavaScript disabled in the Flutter WebView.
// - Localized job content comes from `job.localized` (or options.content):
//     { ar: { title, summary, features:[..], intro }, en: { ... } }
//   Missing parts fall back to the original job text (see ai/prototype_content.js).
// - Fully offline. A CSP meta blocks every network request. All dynamic text is escaped.

const THEMES = Object.freeze({
  classic: { background: '#edf1f7', surface: '#ffffff', ink: '#10223a', muted: '#5d6b82', accent: '#2f5bea', accent2: '#ff7a3d', on: '#ffffff' },
  modern: { background: '#14122b', surface: '#1e1b3d', ink: '#f3f1ff', muted: '#a9a6cc', accent: '#ff4f7b', accent2: '#38e1c6', on: '#14122b' },
  minimal: { background: '#f1f1ef', surface: '#fbfbfa', ink: '#1c1c1b', muted: '#66665f', accent: '#1f1f1f', accent2: '#0f9d8a', on: '#ffffff' },
});

const LANGS = ['ar', 'en'];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}
const stripTags = (text) => String(text ?? '').replace(/<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>/g, '').trim();

export function sanitizeContent(text) {
  return escapeHtml(stripTags(text)).replace(/\r\n?|\n/g, '<br>');
}
// Single-line escaped text (titles, attributes).
function inline(text) {
  return escapeHtml(stripTags(text)).replace(/\s+/g, ' ').trim();
}
function clip(text, max) {
  const chars = Array.from(String(text ?? ''));
  if (chars.length <= max) return chars.join('');
  const head = chars.slice(0, max).join('');
  const cut = head.lastIndexOf(' ');
  return `${(cut > max * 0.6 ? head.slice(0, cut) : head).trim()}…`;
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
  return [...new Set(entries)].map((line) => clip(line, 90)).slice(0, 3);
}

function tagList(value) {
  let list = value;
  if (!Array.isArray(list)) { try { list = JSON.parse(value); } catch { list = []; } }
  return (Array.isArray(list) ? list : []).filter((t) => typeof t === 'string' && t.trim()).slice(0, 8);
}

const SOURCE_NAMES = { freelancer: { ar: 'فريلانسر', en: 'Freelancer' }, mostaql: { ar: 'مستقل', en: 'Mostaql' }, khamsat: { ar: 'خمسات', en: 'Khamsat' } };

const CATEGORY = Object.freeze({
  editorial: {
    label: { ar: 'محتوى وتحرير', en: 'Content & editing' },
    preview: { ar: 'من المسودة إلى النص الجاهز', en: 'From draft to final text' },
    tagline: { ar: 'نص يُقرأ بسلاسة ويصل إلى الجمهور الذي كُتب له.', en: 'Text that reads smoothly and reaches the audience it was written for.' },
    how: {
      ar: ['نبدأ بفهم الجمهور والنبرة قبل كتابة أي سطر، ثم نثبّت مصطلحات العمل.', 'تصلك مسودة أولى للمراجعة، وكل ملاحظة تظهر في النسخة التالية.', 'قراءة أخيرة للاتساق والإملاء قبل التسليم.'],
      en: ['We start with the audience and tone before writing a single line, then lock the terminology.', 'You receive a first draft to review, and every note shows up in the next version.', 'A final read for consistency and spelling before delivery.'],
    },
  },
  creative: {
    label: { ar: 'تصميم وهوية', en: 'Design & identity' },
    preview: { ar: 'اتجاهات بصرية مقترحة', en: 'Proposed visual directions' },
    tagline: { ar: 'هوية تعبّر عن مشروعك قبل أن يقرأ أحد كلمة واحدة.', en: 'An identity that speaks for your project before anyone reads a word.' },
    how: {
      ar: ['نجمع مراجعك ونحوّلها إلى لوحة اتجاه واضحة.', 'نعرض اتجاهات محددة بدل خيارات مشتتة، ثم نعمّق الاتجاه المعتمد.', 'تُسلَّم الملفات بصيغ جاهزة للاستخدام مع شرح مختصر للتطبيق.'],
      en: ['We gather your references and turn them into a clear direction board.', 'We present focused directions instead of a pile of options, then deepen the approved one.', 'Files are delivered in ready-to-use formats with a short guide on applying them.'],
    },
  },
  campaign: {
    label: { ar: 'تسويق وحملات', en: 'Marketing & campaigns' },
    preview: { ar: 'شكل الحملة على كل قناة', en: 'The campaign on each channel' },
    tagline: { ar: 'رسالة واحدة واضحة، تتشكل بما يناسب كل منصة.', en: 'One clear message, shaped for each platform.' },
    how: {
      ar: ['نحدد الجمهور والهدف والرسالة الأساسية قبل صياغة المحتوى.', 'نجهّز محتوى لكل قناة بنبرة العلامة، مع تقويم نشر نراجعه معاً.', 'نتابع ما نجح ونبني عليه بدل البدء من الصفر.'],
      en: ['We define the audience, goal and core message before writing content.', 'Content is prepared per channel in the brand voice, with a publishing calendar we review together.', 'We track what worked and build on it instead of starting over.'],
    },
  },
  video: {
    label: { ar: 'فيديو وحركة', en: 'Video & motion' },
    preview: { ar: 'المشاهد بالتسلسل', en: 'Scenes in sequence' },
    tagline: { ar: 'فكرتك مشاهد متتابعة، تراها قبل التصوير أو المونتاج.', en: 'Your idea as sequenced scenes you can see before production.' },
    how: {
      ar: ['نكتب تسلسل المشاهد ونراجعه معك قبل أي إنتاج.', 'لقطة أولية للإيقاع والانتقالات لنتفق على الاتجاه مبكراً.', 'يُسلَّم المقطع بالمقاسات المتفق عليها بعد جولة مراجعة.'],
      en: ['We write the scene sequence and review it with you before any production.', 'A first look at pacing and transitions so the direction is agreed early.', 'The video is delivered in the agreed sizes after a review round.'],
    },
  },
  service: {
    label: { ar: 'خدمة احترافية', en: 'Professional service' },
    preview: { ar: 'رحلة العمل خطوة بخطوة', en: 'The work, step by step' },
    tagline: { ar: 'تصور واضح لما ستستلمه، قبل أن يبدأ العمل الفعلي.', en: 'A clear picture of what you will receive, before the real work begins.' },
    how: {
      ar: ['نحوّل طلبك إلى نقاط محددة نتفق عليها، فلا يبقى شيء ضمنياً.', 'نموذج أولي نعدّل عليه قبل تثبيت التفاصيل.', 'تُسلَّم النتيجة مع شرح موجز، ونبقى متاحين للتوضيح.'],
      en: ['We turn your request into specific points we agree on, so nothing stays implicit.', 'A first concept we refine before locking the details.', 'The result is delivered with a brief walkthrough, and we stay available to clarify.'],
    },
  },
});

const UI = {
  ar: {
    brand: 'تصور مشروعك', browse: 'تصفّح التصور', how: 'كيف سننفذه',
    note: 'نموذج بصري للعرض، وليس منتجاً مكتملاً أو نتيجة منفذة.', hint: 'تنقّل بين التبويبات لتستعرض التصور',
    glance: 'نظرة سريعة', type: 'نوع العمل', source: 'المصدر', posted: 'تاريخ نشر الطلب', tags: 'التقنيات المطلوبة',
    understood: 'كما فهمنا مشروعك', understoodFallback: 'ملخص لما فهمناه من طلبك.',
    focus: 'ما سنركّز عليه', focusSub: 'النقاط الأساسية في طلبك، وطريقة تعاملنا مع كل منها.',
    road: 'من الاتفاق إلى التسليم', roadSub: 'أربع خطوات واضحة تُبقيك على اطلاع.', gets: 'ما تحصل عليه:',
    digits: ['١', '٢', '٣', '٤'],
    steps: [
      ['نتفاهم على التفاصيل', 'نراجع المطلوب والأولويات ونجيب عن الأسئلة المفتوحة.', 'ملخص مكتوب لما اتفقنا عليه.'],
      ['نعتمد الاتجاه', 'نراجع هذا التصور ونعدّل الشكل أو المحتوى على ملاحظاتك.', 'نسخة معدلة من التصور.'],
      ['ننفّذ', 'نعمل على النطاق المتفق عليه ونشاركك التقدم أثناء العمل.', 'تحديثات دورية على التقدم.'],
      ['نسلّم ونراجع', 'تستلم النتيجة ونغلق الملاحظات الأخيرة.', 'النسخة النهائية.'],
    ],
    price: 'الميزانية المبدئية', priceNote: 'قابلة للمراجعة بعد الاتفاق على النطاق.',
    time: 'المدة المتوقعة', timeNote: 'تقدير أولي يتغير مع النطاق والمراجعات.', days: 'يوم', unspecified: 'غير محدد',
    statsTitle: 'الميزانية والمدة', statsSub: 'أرقام أولية لبدء الحديث، وليست التزاماً نهائياً.',
    noteTitle: 'رسالة لك', noteSub: 'ما أود قوله لك عن هذا المشروع.',
    faqTitle: 'أسئلة قد تخطر لك',
    faq: [
      ['هل هذا التصور هو النتيجة النهائية؟', 'لا. هو نموذج بصري للنقاش، يوضح الاتجاه قبل التنفيذ.'],
      ['هل يمكن تعديل النطاق لاحقاً؟', 'نعم، ويُعاد الاتفاق على الميزانية والمدة إن تغيّر شيء.'],
      ['كيف نبدأ؟', 'يكفي أن تراجع التصور وتخبرني بأي ملاحظة، ثم نثبّت التفاصيل ونبدأ.'],
    ],
    ctaTitle: 'جاهز لنحوّل هذا التصور إلى عمل حقيقي', ctaText: 'راجع التصور وأخبرني بملاحظاتك، ثم نثبّت التفاصيل ونبدأ.', top: 'العودة إلى البداية',
    foot: 'تصور أولي مولّد للعرض', draft: 'نموذج أولي للعرض', defaultTitle: 'فكرة مشروعك، بشكل أوضح',
    defaultHero: 'تصور بصري أولي يوضح اتجاه التنفيذ.', author: 'مع التحية',
  },
  en: {
    brand: 'Project concept', browse: 'Browse the concept', how: 'How it will be done',
    note: 'A visual concept for presentation, not a finished product or a delivered result.', hint: 'Switch tabs to explore the concept',
    glance: 'At a glance', type: 'Type of work', source: 'Source', posted: 'Request posted', tags: 'Technologies',
    understood: 'How we understood your project', understoodFallback: 'A summary of what we understood from your request.',
    focus: 'What we will focus on', focusSub: 'The key points of your request, and how we will handle each one.',
    road: 'From agreement to delivery', roadSub: 'Four clear steps that keep you informed.', gets: 'You receive:',
    digits: ['1', '2', '3', '4'],
    steps: [
      ['We align on the details', 'We review requirements and priorities and answer any open questions.', 'A written summary of what we agreed.'],
      ['We confirm the direction', 'We review this concept and adjust the look or content from your notes.', 'A refined version of the concept.'],
      ['We build', 'We work on the agreed scope and share progress along the way.', 'Regular progress updates.'],
      ['We deliver and review', 'You receive the result and we close any final notes.', 'The final version.'],
    ],
    price: 'Initial budget', priceNote: 'Open to review once the scope is agreed.',
    time: 'Estimated duration', timeNote: 'A first estimate that shifts with scope and revisions.', days: 'days', unspecified: 'Not specified',
    statsTitle: 'Budget and timing', statsSub: 'Starting figures for the conversation, not a final commitment.',
    noteTitle: 'A note for you', noteSub: 'What I would like to say about this project.',
    faqTitle: 'Questions you may have',
    faq: [
      ['Is this concept the final result?', 'No. It is a visual draft for discussion that shows the direction before work starts.'],
      ['Can the scope change later?', 'Yes, and we revisit budget and timing if anything changes.'],
      ['How do we start?', 'Review the concept and share any notes, then we lock the details and begin.'],
    ],
    ctaTitle: 'Ready to turn this concept into real work', ctaText: 'Review the concept and share your notes, then we lock the details and begin.', top: 'Back to top',
    foot: 'Concept generated for presentation', draft: 'Concept preview', defaultTitle: 'Your project idea, made clearer',
    defaultHero: 'A first visual concept showing the direction of the work.', author: 'Best regards',
  },
};

/* ---------- interactive previews (pure HTML/CSS tabs, bilingual) ---------- */

function tabs(id, labels, panels) {
  const radios = labels.map((_, i) => `<input type="radio" name="${id}" id="${id}-${i}"${i === 0 ? ' checked' : ''}>`).join('');
  const bar = labels.map((label, i) => `<label for="${id}-${i}">${label}</label>`).join('');
  return `<div class="tabs">${radios}<div class="tabbar">${bar}</div><div class="panels">${panels.map((p) => `<div class="panel">${p}</div>`).join('')}</div></div>`;
}

function previewFor(category, l, t) {
  const p = (ar, en) => (l === 'ar' ? ar : en);
  const id = `pv-${l}`;
  if (category === 'editorial') {
    const meter = (label, v) => `<span>${label}</span><span class="track"><b style="--v:${v}%"></b></span>`;
    return tabs(id, [p('مسودة', 'Draft'), p('مراجعة', 'Review'), p('جاهز', 'Final')], [
      `<div class="paper"><small class="tag">${p('المسودة الأولى', 'First draft')}</small><h4 dir="auto">${t}</h4><i class="ln"></i><i class="ln w90"></i><i class="ln w70"></i><i class="ln"></i><i class="ln w45"></i></div>`,
      `<div class="paper"><small class="tag">${p('المراجعة', 'Review')}</small><h4 dir="auto">${t}</h4><i class="ln"></i><i class="ln hl w90"></i><span class="note">${p('جملة طويلة، نقترح تقسيمها', 'Long sentence, we suggest splitting it')}</span><i class="ln w70"></i><i class="ln hl"></i><span class="note alt">${p('وحّدنا المصطلح في النص كله', 'Unified the term across the text')}</span></div>`,
      `<div class="paper"><small class="tag">${p('النسخة النهائية', 'Final version')}</small><h4 dir="auto">${t}</h4><i class="ln"></i><i class="ln w90"></i><i class="ln w70"></i><div class="meter">${meter(p('اتساق اللغة', 'Language consistency'), 94)}${meter(p('وضوح الرسالة', 'Message clarity'), 88)}${meter(p('مناسبة الجمهور', 'Audience fit'), 96)}</div><span class="stamp">${p('جاهز للنشر', 'Ready to publish')}</span></div>`,
    ]);
  }
  if (category === 'creative') {
    const dirs = [
      { n: p('هادئ وموثوق', 'Calm and trusted'), s: p('هادئ', 'Calm'), c1: '#2b4a6f', c2: '#8fb8c9', c3: '#e8eef2', f: 'serif' },
      { n: p('جريء ومباشر', 'Bold and direct'), s: p('جريء', 'Bold'), c1: '#e63946', c2: '#1d1d2b', c3: '#f1f3f5', f: 'heavy' },
      { n: p('حيوي ومرح', 'Lively and playful'), s: p('حيوي', 'Lively'), c1: '#7b2ff7', c2: '#00c2a8', c3: '#f9c80e', f: 'round' },
    ];
    return tabs(id, dirs.map((d) => d.s), dirs.map((d) => `<div class="canvas" style="--c1:${d.c1};--c2:${d.c2}"><span class="ring"></span><small>${d.n}</small><strong class="logo ${d.f}" dir="auto">${t}</strong></div><div class="sw"><i style="background:${d.c1}"></i><i style="background:${d.c2}"></i><i style="background:${d.c3}"></i><span>${p('اللوحة اللونية للاتجاه', 'Direction color palette')}</span></div>`));
  }
  if (category === 'campaign') {
    const head = `<div class="ph"><i class="av"></i><div><b>${p('اسم العلامة', 'Brand name')}</b><small>${p('منشور تعريفي', 'Intro post')}</small></div></div>`;
    return tabs(id, [p('إنستغرام', 'Instagram'), p('لينكدإن', 'LinkedIn'), p('بريد', 'Email')], [
      `<div class="post">${head}<div class="img sq"><strong dir="auto">${t}</strong></div><i class="ln"></i><i class="ln w70"></i><div class="react"><span>${p('إعجاب', 'Like')}</span><span>${p('تعليق', 'Comment')}</span><span>${p('مشاركة', 'Share')}</span></div></div>`,
      `<div class="post">${head}<p class="cap" dir="auto"><b>${t}</b></p><i class="ln"></i><i class="ln w90"></i><i class="ln w70"></i><div class="img wide"></div><div class="react"><span>${p('أعجبني', 'Like')}</span><span>${p('تعليق', 'Comment')}</span></div></div>`,
      `<div class="post"><div class="subject"><small>${p('الموضوع', 'Subject')}</small><b dir="auto">${t}</b></div><i class="ln"></i><i class="ln w90"></i><i class="ln w70"></i><i class="ln w45"></i><span class="fakebtn">${p('اطلب الآن', 'Order now')}</span></div>`,
    ]);
  }
  if (category === 'video') {
    const tl = '<div class="tl"><i></i><i></i><i></i><i></i><i></i><i></i><em class="play"></em></div>';
    return tabs(id, [p('الافتتاح', 'Opening'), p('الفكرة', 'Idea'), p('الختام', 'Closing')], [
      `<div class="screen s1"><i class="sun"></i><i class="hill"></i><span class="cap2" dir="auto">${t}</span></div>${tl}`,
      `<div class="screen s2"><i class="bar b1"></i><i class="bar b2"></i><i class="bar b3"></i><i class="bar b4"></i><i class="bar b5"></i><span class="cap2">${p('الفكرة الأساسية في ثوانٍ', 'The core idea in seconds')}</span></div>${tl}`,
      `<div class="screen s3"><i class="orb"></i><i class="orb o2"></i><span class="cap2">${p('دعوة واضحة للخطوة التالية', 'A clear call to the next step')}</span></div>${tl}`,
    ]);
  }
  return tabs(id, [p('الطلب', 'Request'), p('التنفيذ', 'Progress'), p('النتيجة', 'Result')], [
    `<div class="app"><small class="tag">${p('طلب جديد', 'New request')}</small><h4 dir="auto">${t}</h4><div class="field"><i class="ln w45"></i><span></span></div><div class="field"><i class="ln w70"></i><span></span></div><span class="fakebtn">${p('ابدأ العمل', 'Start work')}</span></div>`,
    `<div class="app"><small class="tag">${p('جارٍ التنفيذ', 'In progress')}</small><h4>${p('نرتّب المطلوب', 'Organizing the work')}</h4><div class="prog"><b></b></div><ul class="steps"><li class="done">${p('فهم التفاصيل', 'Understand the details')}</li><li class="done">${p('إعداد النموذج', 'Prepare the draft')}</li><li>${p('مراجعة معك', 'Review with you')}</li></ul></div>`,
    `<div class="app"><small class="tag">${p('جاهز للمراجعة', 'Ready for review')}</small><div class="okrow"><span class="ok">✓</span><h4 dir="auto">${t}</h4></div><div class="rowk"><span>${p('المطلوب', 'Requirements')}</span><b>${p('مكتمل', 'Done')}</b></div><div class="rowk"><span>${p('الملاحظات', 'Notes')}</span><b>${p('مفتوحة لك', 'Open to you')}</b></div><div class="rowk"><span>${p('الخطوة التالية', 'Next step')}</span><b>${p('اعتماد أو تعديل', 'Approve or adjust')}</b></div></div>`,
  ]);
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
.lang-radio{position:absolute;opacity:0;pointer-events:none}
#lang-ar:checked~.page{direction:rtl}
#lang-en:checked~.page{direction:ltr}
#lang-ar:checked~.page [data-l="en"],#lang-en:checked~.page [data-l="ar"]{display:none!important}
.progress{position:fixed;top:0;inset-inline:0;height:3px;z-index:60;transform-origin:right;transform:scaleX(var(--p,0));background:linear-gradient(90deg,var(--accent),var(--accent2))}
#lang-en:checked~.page .progress{transform-origin:left}
.aura{position:fixed;inset:0;z-index:-1;overflow:hidden;pointer-events:none}
.aura i{position:absolute;border-radius:50%;filter:blur(90px);opacity:.26}
.aura i:first-child{width:420px;height:420px;background:var(--accent);top:-160px;right:-120px}
.aura i:last-child{width:380px;height:380px;background:var(--accent2);bottom:-160px;left:-140px}
.wrap{max-width:1120px;margin:auto;padding:0 20px}
.topbar{position:sticky;top:0;z-index:50;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);background:color-mix(in srgb,var(--bg) 72%,transparent)}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;text-decoration:none}
.mark{width:34px;height:34px;border-radius:11px;display:grid;place-items:center;background:var(--accent);color:var(--on);font-weight:800}
.langsw{display:flex;gap:2px;padding:3px;background:var(--soft);border-radius:99px;font-size:13px;font-weight:700;border:1px solid var(--line)}
.langsw label{padding:4px 14px;border-radius:99px;cursor:pointer;color:var(--muted);transition:background .2s,color .2s}
#lang-ar:checked~.page label[for="lang-ar"],#lang-en:checked~.page label[for="lang-en"]{background:var(--surface);color:var(--ink);box-shadow:0 2px 8px color-mix(in srgb,var(--ink) 14%,transparent)}
#lang-ar:focus-visible~.page label[for="lang-ar"],#lang-en:focus-visible~.page label[for="lang-en"]{outline:2px solid var(--accent);outline-offset:2px}
.hero{position:relative;display:grid;gap:34px;padding:22px 0 46px}
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
.stamp{position:absolute;inset-inline-end:14px;bottom:14px;border:2px solid var(--accent2);color:var(--accent2);padding:2px 12px;border-radius:8px;font-weight:800;font-size:13px;transform:rotate(-6deg)}
.meter{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-size:12px;color:var(--muted);align-items:center;margin-top:14px;max-width:70%}
.track{height:6px;border-radius:4px;background:var(--line);overflow:hidden}
.track b{display:block;height:100%;width:var(--v);background:linear-gradient(90deg,var(--accent2),var(--accent))}
.canvas{position:relative;overflow:hidden;border-radius:14px;min-height:210px;padding:20px;background:linear-gradient(135deg,var(--c1),var(--c2));color:#fff;display:flex;flex-direction:column;justify-content:flex-end;gap:6px}
.canvas small{font-size:12px;opacity:.85}
.logo{font-size:26px;line-height:1.3}
.logo.serif{font-family:Georgia,"Times New Roman",serif;font-weight:400}
.logo.heavy{font-weight:900}
.logo.round{font-weight:700;border:2px solid #fff;border-radius:99px;padding:4px 16px;align-self:flex-start}
.ring{position:absolute;width:150px;height:150px;border-radius:50%;border:1px solid #fff;opacity:.35;top:-40px;inset-inline-start:-30px;box-shadow:0 0 0 20px rgba(255,255,255,.08)}
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
.sun{position:absolute;width:64px;height:64px;border-radius:50%;background:#f5c875;top:26px;inset-inline-end:50px}
.hill{position:absolute;inset:auto -10% -60px;height:150px;background:#3f8275;clip-path:polygon(0 62%,30% 15%,50% 52%,70% 22%,100% 67%,100% 100%,0 100%)}
.bar{position:absolute;bottom:0;width:13%;background:rgba(255,255,255,.22);border-radius:6px 6px 0 0}
.b1{inset-inline-end:8%;height:55%}.b2{inset-inline-end:24%;height:80%}.b3{inset-inline-end:40%;height:45%}.b4{inset-inline-end:56%;height:68%}.b5{inset-inline-end:72%;height:35%}
.orb{position:absolute;width:110px;height:110px;border-radius:50%;border:2px solid rgba(255,255,255,.5);top:24px;inset-inline-start:40px}
.orb.o2{width:60px;height:60px;top:70px;inset-inline-start:92px;background:rgba(255,255,255,.2)}
.cap2{position:absolute;bottom:10px;inset-inline:12px;color:#fff;font-size:13px;font-weight:700;text-shadow:0 2px 6px rgba(0,0,0,.5)}
.tl{position:relative;display:flex;gap:3px;padding:6px;margin-top:10px;background:var(--bg);border-radius:9px;overflow:hidden}
.tl i{flex:1;height:22px;border-radius:5px;background:color-mix(in srgb,var(--accent) 55%,var(--surface))}
.tl i:nth-child(even){background:color-mix(in srgb,var(--accent2) 55%,var(--surface))}
.play{position:absolute;top:0;bottom:0;width:2px;background:var(--ink);inset-inline-start:0;animation:scrub 6s linear infinite}
.field{display:flex;flex-direction:column;gap:4px;margin:12px 0}
.field span{height:34px;border:1px solid var(--line);border-radius:9px;background:var(--surface)}
.prog{height:8px;border-radius:5px;background:var(--line);overflow:hidden;margin:6px 0 14px}
.prog b{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--accent2),var(--accent));animation:fill 2.4s ease forwards}
.steps{list-style:none;padding:0;font-size:14px;color:var(--muted)}
.steps li{padding:3px 0}
.steps li::before{content:"○";margin-inline-end:8px}
.steps li.done{color:var(--ink)}
.steps li.done::before{content:"●";color:var(--accent2)}
.okrow{display:flex;align-items:center;gap:10px}
.ok{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;background:var(--accent2);color:#0b1020;font-weight:800;flex:none}
.rowk{display:flex;justify-content:space-between;padding:9px 0;border-top:1px solid var(--line);font-size:14px}
.rowk span{color:var(--muted)}
.sec{padding:46px 0}
.sec h2{font-size:clamp(24px,4vw,34px);line-height:1.35;font-weight:800;margin-bottom:10px}
.sub{color:var(--muted);max-width:60ch;margin-bottom:22px}
.facts{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));margin-bottom:14px}
.fact{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
.fact small{display:block;color:var(--muted);font-size:12px}
.fact b{font-size:16px}
.tagrow{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.tagrow small{color:var(--muted);font-size:13px;margin-inline-end:4px}
.tagrow span.t{padding:3px 12px;border-radius:8px;background:var(--soft);border:1px solid var(--line);font-size:13px;font-weight:700}
.card{border:1px solid var(--line);background:var(--surface);border-radius:14px;margin-bottom:10px}
.card summary{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 18px;cursor:pointer;font-weight:700;list-style:none}
.card summary::-webkit-details-marker{display:none}
.card summary::after{content:"+";font-size:22px;line-height:1;color:var(--accent);transition:transform .25s;flex:none}
.card[open] summary::after{transform:rotate(45deg)}
.card .body{padding:0 18px 16px;color:var(--muted)}
.road{position:relative;padding-inline-start:46px;--rp:1}
.road::before,.road::after{content:"";position:absolute;inset-inline-start:15px;top:6px;bottom:30px;width:2px;background:var(--line)}
.road::after{background:var(--accent);transform-origin:top;transform:scaleY(var(--rp))}
.rs{position:relative;padding-bottom:26px}
.rs .n{position:absolute;inset-inline-start:-46px;top:0;width:32px;height:32px;border-radius:50%;background:var(--surface);border:2px solid var(--accent);display:grid;place-items:center;font-size:14px;font-weight:800;z-index:1}
.rs h3{font-size:18px;margin-bottom:2px}
.rs p{color:var(--muted)}
.rs .out{display:inline-block;margin-top:6px;font-size:13px;padding:2px 12px;border-radius:8px;background:var(--soft)}
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
.download-page{position:fixed;z-index:20;inset-inline-start:18px;bottom:18px;border:0;border-radius:999px;padding:12px 18px;background:var(--accent);color:#fff;font:inherit;font-size:14px;font-weight:800;box-shadow:0 8px 28px #0003;cursor:pointer}
.download-page:hover{filter:brightness(1.08);transform:translateY(-1px)}
.download-page{display:none}.js .download-page{display:block}
.js .rv{opacity:0;transform:translateY(14px);transition:opacity .6s ease,transform .6s ease}
.js .rv.in{opacity:1;transform:none}
@keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
@keyframes swap{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes fill{to{width:78%}}
@keyframes scrub{from{inset-inline-start:0}to{inset-inline-start:100%}}
@media(min-width:860px){
.hero{grid-template-columns:1fr 1.05fr;align-items:center;padding:50px 0 66px}
.cta{grid-template-columns:1fr auto;align-items:center;padding:44px}
.cta .btn.main{justify-self:end}
}
@media(prefers-reduced-motion:reduce){
html{scroll-behavior:auto}
*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}
.js .rv{opacity:1;transform:none}
}`;
}

// JS only adds polish (progress bar, spotlight, reveal, roadmap fill). Language switch and tabs need no JS.
const SCRIPT = `(function(){try{
var d=document,h=d.documentElement;h.classList.add('js');
var q=function(s){return Array.prototype.slice.call(d.querySelectorAll(s))};
var download=d.querySelector('[data-download-page]');
if(download){download.addEventListener('click',function(){
  var copy=d.documentElement.cloneNode(true),button=copy.querySelector('[data-download-page]');
  if(button)button.remove();
  var html='<!doctype html>\\n'+copy.outerHTML,blob=new Blob([html],{type:'text/html;charset=utf-8'}),url=URL.createObjectURL(blob),a=d.createElement('a');
  var name=(d.title||'jobbot-prototype').replace(/[\\\\/:*?\"<>|]+/g,'-').trim()||'jobbot-prototype';
  a.href=url;a.download=name+'.html';d.body.appendChild(a);a.click();a.remove();setTimeout(function(){URL.revokeObjectURL(url)},1000);
})}
q('[data-scroll]').forEach(function(a){a.addEventListener('click',function(e){var t=d.getElementById(a.getAttribute('data-scroll'));if(t){e.preventDefault();t.scrollIntoView({behavior:'smooth',block:'start'})}})});
var bar=d.querySelector('.progress'),roads=q('.road');
function onScroll(){var y=window.pageYOffset||h.scrollTop,m=h.scrollHeight-h.clientHeight;if(bar&&m>0)bar.style.setProperty('--p',String(Math.min(1,y/m)));
roads.forEach(function(rd){var r=rd.getBoundingClientRect();if(r.height>0){rd.style.setProperty('--rp',String(Math.max(0,Math.min(1,(h.clientHeight*0.65-r.top)/r.height))))}})}
window.addEventListener('scroll',onScroll,{passive:true});onScroll();
q('.hero').forEach(function(hero){hero.addEventListener('pointermove',function(e){var r=hero.getBoundingClientRect();hero.style.setProperty('--mx',(e.clientX-r.left)+'px');hero.style.setProperty('--my',(e.clientY-r.top)+'px')})});
var rv=q('.rv');
if('IntersectionObserver' in window){var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target)}})},{threshold:.08});rv.forEach(function(n){io.observe(n)})}
else{rv.forEach(function(n){n.classList.add('in')})}
}catch(e){document.documentElement.classList.remove('js')}})();`;

/* ---------- page ---------- */

export function buildPrototype(job = {}, proposal = '', options = {}) {
  const theme = Object.hasOwn(THEMES, options.theme) ? options.theme : 'classic';
  const category = categoryFor(job);
  const meta = CATEGORY[category];
  const content = options.content ?? job.localized ?? null;
  const fallbackFeatures = featureItems(job, proposal);
  const summaryRaw = stripTags(job.description).replace(/\s+/g, ' ');
  const arabicRatio = (() => {
    const text = `${job.title || ''} ${summaryRaw}`;
    const letters = (text.match(/\p{L}/gu) || []).length || 1;
    return (text.match(/[\u0600-\u06FF]/g) || []).length / letters;
  })();
  const defaultLang = LANGS.includes(options.lang) ? options.lang : (arabicRatio > 0.4 || content?.ar ? 'ar' : 'en');

  const loc = (l) => {
    const c = content?.[l] && typeof content[l] === 'object' ? content[l] : {};
    const features = (Array.isArray(c.features) ? c.features : []).filter((f) => typeof f === 'string' && f.trim()).slice(0, 3);
    return {
      title: inline(c.title || job.title || ''),
      summary: clip(stripTags(c.summary || summaryRaw).replace(/\s+/g, ' '), 520),
      features: (features.length ? features : fallbackFeatures).map((f) => inline(f)),
      intro: typeof c.intro === 'string' ? clip(stripTags(c.intro).replace(/\s+/g, ' '), 520) : '',
    };
  };

  const tags = tagList(job.tags);
  const posted = typeof job.posted_at === 'string' && /^\d{4}-\d{2}-\d{2}/.test(job.posted_at) ? job.posted_at.slice(0, 10) : '';
  const author = options.author ? inline(options.author) : '';
  const generatedAt = new Date().toISOString().slice(0, 10);

  const pageFor = (l) => {
    const u = UI[l];
    const lc = loc(l);
    const title = lc.title || u.defaultTitle;
    const heroText = clip(lc.summary, 260) || u.defaultHero;
    const sid = (name) => `${name}-${l}`;
    const titleHtml = /[\u0600-\u06FF]/.test(title)
      ? title.split(' ').map((word, i) => `<span class="w" style="--i:${i}">${word}</span>`).join(' ')
      : `<span class="w" style="--i:0">${title}</span>`;

    const factItems = [[u.type, meta.label[l]]];
    if (job.source || job.platform) {
      const raw = String(job.source || job.platform).toLowerCase();
      factItems.push([u.source, SOURCE_NAMES[raw]?.[l] || inline(job.source || job.platform)]);
    }
    if (posted) factItems.push([u.posted, posted]);
    const facts = factItems.map(([k, v]) => `<div class="fact"><small>${k}</small><b>${v}</b></div>`).join('');
    const tagRow = tags.length ? `<div class="tagrow"><small>${u.tags}</small>${tags.map((tg) => `<span class="t" dir="ltr">${inline(tg)}</span>`).join('')}</div>` : '';

    const featureCards = lc.features.map((item, i) => `<details class="card"${i === 0 ? ' open' : ''}><summary><span dir="auto">${item}</span></summary><div class="body">${meta.how[l][i] || meta.how[l][0]}</div></details>`).join('');
    const steps = u.steps.map(([h3, text, out], i) => `<div class="rs"><span class="n">${u.digits[i]}</span><h3>${h3}</h3><p>${text}</p><span class="out">${u.gets} ${out}</span></div>`).join('');
    const faq = u.faq.map(([qn, an]) => `<details class="card"><summary><span>${qn}</span></summary><div class="body">${an}</div></details>`).join('');

    const stats = [];
    if (options.include_price === true) {
      const price = job.estimated_price === null || job.estimated_price === undefined || job.estimated_price === '' ? u.unspecified : inline(job.estimated_price);
      stats.push(`<div class="stat"><span>${u.price}</span><strong>${price}${job.currency ? ` ${inline(job.currency)}` : ''}</strong><span>${u.priceNote}</span></div>`);
    }
    if (options.include_timing === true) {
      const days = job.estimated_days ? `${inline(job.estimated_days)} ${u.days}` : u.unspecified;
      stats.push(`<div class="stat"><span>${u.time}</span><strong>${days}</strong><span>${u.timeNote}</span></div>`);
    }
    const statsSection = stats.length ? `<section class="sec rv"><h2>${u.statsTitle}</h2><p class="sub">${u.statsSub}</p><div class="stats">${stats.join('')}</div></section>` : '';

    const noteText = lc.intro || clip(stripTags(proposal).replace(/\s+/g, ' '), 420);
    const noteSection = noteText ? `<section class="sec rv"><h2>${u.noteTitle}</h2><p class="sub">${u.noteSub}</p><blockquote class="quote" dir="auto">${escapeHtml(noteText)}</blockquote>${author ? `<p class="sig">${u.author}، ${author}</p>` : ''}</section>` : '';

    return `<section class="hero"><div><div class="chips"><span class="chip">${meta.label[l]}</span><span class="chip">${u.draft}</span></div><h1 dir="auto">${titleHtml}</h1><p class="lead" dir="auto">${escapeHtml(heroText)}</p><p class="lead" style="margin-top:8px">${meta.tagline[l]}</p><div class="actions"><a class="btn main" href="#${sid('details')}" data-scroll="${sid('details')}">${u.browse}</a><a class="btn ghost" href="#${sid('focus')}" data-scroll="${sid('focus')}">${u.how}</a></div><p class="note-line">${u.note}</p></div>
<div><div class="stage"><div class="stage-head"><i></i><i></i><i></i><span>${meta.preview[l]}</span></div>${previewFor(category, l, title)}</div><p class="hint">${u.hint}</p></div></section>
<section class="sec rv" id="${sid('details')}"><h2>${u.understood}</h2><p class="sub" dir="auto">${lc.summary ? escapeHtml(lc.summary) : u.understoodFallback}</p><div class="facts">${facts}</div>${tagRow}</section>
<section class="sec rv" id="${sid('focus')}"><h2>${u.focus}</h2><p class="sub">${u.focusSub}</p>${featureCards}</section>
<section class="sec rv"><h2>${u.road}</h2><p class="sub">${u.roadSub}</p><div class="road">${steps}</div></section>
${statsSection}${noteSection}
<section class="sec rv"><h2>${u.faqTitle}</h2>${faq}</section>
<section class="rv"><div class="cta"><div><h2>${u.ctaTitle}</h2><p>${u.ctaText}</p></div><a class="btn main" href="#top" data-scroll="top">${u.top}</a></div></section>
<p class="foot">${u.foot}، ${generatedAt}</p>`;
  };

  const pageTitle = loc(defaultLang).title || UI[defaultLang].defaultTitle;
  const radios = LANGS.map((l) => `<input class="lang-radio" type="radio" name="lang" id="lang-${l}" aria-label="${l === 'ar' ? 'العربية' : 'English'}"${l === defaultLang ? ' checked' : ''}>`).join('');
  const brand = LANGS.map((l) => `<span data-l="${l}">${UI[l].brand}</span>`).join('');

  return `<!doctype html><html lang="${defaultLang}" dir="${defaultLang === 'ar' ? 'rtl' : 'ltr'}" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:"><meta name="description" content="${pageTitle}"><title>${pageTitle}</title><style>${styles()}</style></head><body>${radios}<div class="page"><div class="progress"></div><div class="aura"><i></i><i></i></div><div class="wrap" id="top">
<header class="topbar"><a class="brand" href="#top" data-scroll="top"><span class="mark">J</span><span>${brand}</span></a><div class="langsw"><label for="lang-ar">العربية</label><label for="lang-en">English</label></div></header><button class="download-page" type="button" data-download-page>تنزيل الصفحة كـ HTML</button>
${LANGS.map((l) => `<div data-l="${l}" lang="${l}" dir="${l === 'ar' ? 'rtl' : 'ltr'}">${pageFor(l)}</div>`).join('\n')}
</div></div><script>${SCRIPT}</script></body></html>`;
}
