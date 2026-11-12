const THEMES = Object.freeze({
  classic: `:root{color-scheme:light}body{margin:0;background:#fff;color:#252525;font:17px/1.8 Georgia,"Times New Roman",serif}.page{max-width:850px;margin:48px auto;padding:32px}header,section,footer{padding:22px 0;border-bottom:1px solid #dedede}h1,h2{font-weight:600}h1{font-size:2rem}h2{font-size:1.35rem}footer{border:0;color:#666;font-size:.9rem}`,
  modern: `:root{color-scheme:dark}body{margin:0;background:#1a1a2e;color:#f4f4f8;font:16px/1.8 Arial,Helvetica,sans-serif}.page{max-width:900px;margin:40px auto;padding:30px}header,section,footer{margin:18px 0;padding:24px;border:1px solid #34344c;border-radius:14px;background:#22223a}h1,h2{font-weight:800}h1{font-size:2.2rem;color:#e94560}h2{font-size:1.4rem;color:#e94560}footer{color:#aaa;font-size:.9rem}`,
  minimal: `:root{color-scheme:light}body{margin:0;background:#fff;color:#111;font:15px/1.7 "Courier New",Courier,monospace}.page{max-width:850px;margin:28px auto;padding:20px}header,section,footer{padding:16px 0;border-bottom:1px solid #ddd}h1,h2{font-size:1.1rem;font-weight:400}footer{border:0;color:#555}`,
});

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

export function sanitizeContent(text) {
  const stripped = String(text ?? '').replace(/<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>/g, '').trim();
  return escapeHtml(stripped).replace(/\r\n?|\n/g, '<br>');
}

function displayValue(value) {
  return value === null || value === undefined || value === '' ? 'غير محدد' : String(value);
}

export function buildPrototype(job = {}, proposal = '', options = {}) {
  const theme = Object.hasOwn(THEMES, options.theme) ? options.theme : 'classic';
  const priceSection = options.include_price === true
    ? `<section><h2>التسعير</h2><p>${sanitizeContent(displayValue(job.estimated_price))}${job.currency ? ` ${sanitizeContent(job.currency)}` : ''}</p></section>`
    : '';
  const timingSection = options.include_timing === true
    ? `<section><h2>الوقت المتوقع</h2><p>${sanitizeContent(displayValue(job.estimated_days))}</p></section>`
    : '';
  const generatedAt = new Date().toISOString();
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${sanitizeContent(job.title || 'نموذج أولي')}</title><style>${THEMES[theme]}</style></head><body><main class="page"><header><h1>${sanitizeContent(job.title || 'وظيفة')}</h1><p>المصدر: ${sanitizeContent(displayValue(job.source))}</p><p>تاريخ النشر: ${sanitizeContent(displayValue(job.posted_at))}</p></header><section><h2>عن المشروع</h2><p>${sanitizeContent(job.description || '')}</p></section><section><h2>العرض</h2><p>${sanitizeContent(proposal)}</p></section>${priceSection}${timingSection}<footer>تاريخ الإنشاء: ${sanitizeContent(generatedAt)}</footer></main></body></html>`;
}
