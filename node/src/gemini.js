import * as defaults from './config.js';

export class GeminiError extends Error {
  constructor(status, code, message, details = {}) { super(message); this.name='GeminiError'; this.status=status; this.code=code; this.details=details; }
}
export function createGeminiClient({ config=defaults, fetch:fetchImpl=globalThis.fetch, now=()=>Date.now(), sleep=(ms)=>new Promise((r)=>setTimeout(r,ms)), logger=console }={}) {
  let tail=Promise.resolve(), lastCall=null;
  async function generate({prompt,system,json=false,maxOutputTokens=config.GEMINI_MAX_OUTPUT_TOKENS??8192,timeoutMs=config.GEMINI_TIMEOUT_MS??60000}={}) {
    if(!config.GEMINI_API_KEY) throw new GeminiError(503,'GEMINI_NOT_CONFIGURED','Gemini is unavailable: missing API key');
    if(!config.GEMINI_MODEL) throw new GeminiError(503,'GEMINI_NOT_CONFIGURED','Gemini is unavailable: missing model');
    let unlock; const previous=tail; tail=new Promise((resolve)=>{unlock=resolve;}); await previous;
    try {
      const minGap=config.GEMINI_MIN_GAP_MS??5000;
      if(lastCall!==null) { const wait=minGap-(now()-lastCall); if(wait>0) await sleep(wait); }
      let response, lastStatus=0;
      for(let attempt=0;attempt<3;attempt++) {
        lastCall=now(); const controller=new AbortController(); let timer;
        try {
          timer=setTimeout(()=>controller.abort(),timeoutMs);
          const body={contents:[{parts:[{text:prompt}]}]};
          if(system)body.systemInstruction={parts:[{text:system}]};
          const generationConfig={}; if(json)generationConfig.responseMimeType='application/json'; if(maxOutputTokens>0)generationConfig.maxOutputTokens=maxOutputTokens;
          if(Object.keys(generationConfig).length)body.generationConfig=generationConfig;
          response=await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.GEMINI_MODEL)}:generateContent`,{method:'POST',headers:{'content-type':'application/json','x-goog-api-key':config.GEMINI_API_KEY},body:JSON.stringify(body),signal:controller.signal});
        } catch(error) { if(error?.name==='AbortError')throw new GeminiError(504,'GEMINI_TIMEOUT','Gemini request timed out'); if(attempt===2)throw new GeminiError(502,'GEMINI_UNAVAILABLE','Gemini is unavailable'); await sleep(250*(attempt+1)); continue; }
        finally { clearTimeout(timer); }
        lastStatus=response.status;
        if(response.status===429 && attempt<2) { const retry=Number(response.headers?.get?.('retry-after')); await sleep((Number.isFinite(retry)&&retry>0?retry*1000:5000)+2000); continue; }
        break;
      }
      if(lastStatus===429)throw new GeminiError(503,'GEMINI_RATE_LIMITED','Gemini rate limit reached');
      if(lastStatus===401||lastStatus===403)throw new GeminiError(502,'GEMINI_AUTH_FAILED','Gemini authentication failed');
      if(!response?.ok)throw new GeminiError(502,'GEMINI_UNAVAILABLE',`Gemini is unavailable: HTTP ${Number.isInteger(lastStatus)?lastStatus:'unknown'} response`);
      let data; try{data=await response.json();}catch{throw new GeminiError(502,'GEMINI_BAD_RESPONSE','Gemini returned an invalid response');}
      const candidates=data?.candidates||[]; const text=candidates.flatMap(c=>c?.content?.parts||[]).map(p=>p?.text||'').join('').trim();
      if(!text)throw new GeminiError(502,'GEMINI_BAD_RESPONSE','Gemini returned no text');
      if(json){try{JSON.parse(text.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));}catch{throw new GeminiError(502,'GEMINI_BAD_RESPONSE','Gemini returned invalid JSON');}}
      const meta=data.usageMetadata||{};
      return {text,usage:{model:config.GEMINI_MODEL,inputTokens:meta.promptTokenCount||0,outputTokens:(meta.candidatesTokenCount||0)+(meta.thoughtsTokenCount||0)}};
    } finally { unlock(); }
  }
  return {generate};
}
