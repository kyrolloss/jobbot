// Bilingual (ar/en) client-facing content for the prototype page.
// Usage (inside the prototype generation route):
//   const generated = await gemini.generate({ prompt: buildPrototypeContentPrompt(job, job.proposal), json: true });
//   const localized = parseLocalized(generated.text);          // null when the model output is unusable
//   const html = buildPrototype({ ...job, localized }, job.proposal, options);

const LIMITS = { title: 90, summary: 260, feature: 70, intro: 380 };

function cut(value, max) {
  const text = String(value ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join('').trim()}…` : text;
}

export function buildPrototypeContentPrompt(job, proposal) {
  const description = cut(job.description, 4000);
  const title = cut(job.title, 300);
  const proposalText = cut(proposal, 3000);
  return `You prepare the text of a short, client-facing concept page for a freelance job. The page is shown to the CLIENT who posted the job. Write every field twice: once in Arabic ("ar", simple Modern Standard Arabic) and once in English ("en", clear and plain).

JOB TITLE:
${title}

JOB DESCRIPTION:
${description}

FREELANCER'S PROPOSAL (source for the intro only):
${proposalText || '(none)'}

Return ONLY a JSON object, no markdown, in exactly this shape:
{"ar":{"title":"","summary":"","features":["","",""],"intro":""},"en":{"title":"","summary":"","features":["","",""],"intro":""}}

Rules:
- Stay faithful to the job text. Never invent requirements, tools, numbers, prices, dates, deadlines or guarantees.
- title: a clean project name, at most ${LIMITS.title} characters, without platform noise or job-board prefixes.
- summary: at most ${LIMITS.summary} characters. Explain what the client needs, in neutral wording such as "We understand you need...".
- features: exactly 3 short points (at most ${LIMITS.feature} characters each) taken from the real requirements. Each must be a concrete thing the client will get or a focus of the work. Do not number them.
- intro: at most ${LIMITS.intro} characters. A short, warm, first-person note from the freelancer to the client, grounded ONLY in what the proposal says. No prices, no dates, no promises that the proposal does not make. If the proposal is empty, write a brief neutral note about reviewing the concept together.
- The Arabic and English versions must say the same thing, not two different texts.
- Output valid JSON only.`;
}

export function parseLocalized(text) {
  let raw = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  raw = raw.slice(start, end + 1);
  let data;
  try { data = JSON.parse(raw); } catch { return null; }
  const out = {};
  for (const lang of ['ar', 'en']) {
    const part = data?.[lang];
    if (!part || typeof part !== 'object') return null;
    const features = (Array.isArray(part.features) ? part.features : [])
      .filter((f) => typeof f === 'string' && f.trim()).map((f) => cut(f, LIMITS.feature)).slice(0, 3);
    const title = cut(part.title, LIMITS.title);
    const summary = cut(part.summary, LIMITS.summary);
    if (!title || !summary || features.length === 0) return null;
    out[lang] = { title, summary, features, intro: cut(part.intro, LIMITS.intro) };
  }
  return out;
}
