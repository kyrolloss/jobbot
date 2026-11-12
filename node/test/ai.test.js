import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGeminiClient } from '../src/gemini.js';
import { openDb,closeDb } from '../src/db.js';
import { createServer } from '../src/server.js';

test('Gemini client serializes calls and respects spacing with injected time',async()=>{
  let time=10000,calls=0; const client=createGeminiClient({config:{GEMINI_API_KEY:'secret-test-key',GEMINI_MODEL:'test-model',GEMINI_MIN_GAP_MS:5000,GEMINI_MAX_OUTPUT_TOKENS:100},now:()=>time,sleep:async(ms)=>{time+=ms;},fetch:async()=>{calls++;return {ok:true,status:200,json:async()=>({candidates:[{content:{parts:[{text:'ok'}]}}],usageMetadata:{promptTokenCount:2,candidatesTokenCount:3,thoughtsTokenCount:4}})};}});
  const [a,b]=await Promise.all([client.generate({prompt:'x'}),client.generate({prompt:'y'})]); assert.equal(calls,2);assert.equal(time,15000);assert.equal(a.usage.outputTokens,7);assert.equal(b.text,'ok');
});
test('Gemini retries 429 and reports bounded rate failure',async()=>{const waits=[];const client=createGeminiClient({config:{GEMINI_API_KEY:'x',GEMINI_MODEL:'m',GEMINI_MIN_GAP_MS:1},now:()=>10000,sleep:async n=>waits.push(n),fetch:async()=>({ok:false,status:429,headers:{get:()=> '1'},json:async()=>({})})});await assert.rejects(client.generate({prompt:'p'}),e=>e.code==='GEMINI_RATE_LIMITED');assert.equal(waits.length,2);});

test('AI endpoints cache, regenerate, scope, persist, and serialize same-feature calls',async(t)=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ai-offline-')),db=openDb(path.join(dir,'test.db'));
  db.prepare("INSERT INTO jobs(source,external_id,title,description,url,budget,status,created_at) VALUES('freelancer','one','Flutter app','Build a Flutter mobile app','https://x','$100','sent','2026-01-01 00:00:00')").run();
  const id=Number(db.prepare('SELECT last_insert_rowid() id').get().id);
  const key='ai-api-test-key-at-least-24-characters';let calls=0;
  const outputs=[JSON.stringify({verdict:'apply',score:8,competition:'low',budget_fit:'مناسب',reasons:['سبب أول','سبب ثان'],suggested_bid:100}), 'Proposal text',JSON.stringify({tasks:[{name:'Build app',hours:4}],total_hours:4,risks:[],questions_for_client:[]})];
  const api=createServer({db,config:{API_KEY:key,API_HOST:'127.0.0.1',CORS_ORIGINS:[],GEMINI_API_KEY:'fake',GEMINI_MODEL:'fake',SAAS_ENABLED:false,PROFILE_PATH:path.join(dir,'profile.md')},geminiClient:{generate:async()=>({text:outputs[calls++],usage:{model:'fake',inputTokens:2,outputTokens:3}})},sources:[{name:'freelancer'}]});fs.writeFileSync(path.join(dir,'profile.md'),'Flutter developer');const address=await api.listen(0,'127.0.0.1'),base=`http://127.0.0.1:${address.port}`;t.after(async()=>{await api.close();closeDb(db);fs.rmSync(dir,{recursive:true,force:true});});
  const req=(route,body={},headers={})=>fetch(base+route,{method:'POST',headers:{'X-API-Key':key,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await fetch(`${base}/jobs/${id}/evaluate`)).status,401);
  let response=await req(`/jobs/${id}/evaluate`);let payload=await response.json();assert.equal(payload.result.verdict,'apply');assert.equal(payload.usage.input_tokens,2);
  payload=await (await req(`/jobs/${id}/evaluate`)).json();assert.equal(payload.cached,true);assert.equal(calls,1);
  await req(`/jobs/${id}/evaluate`,{regenerate:true});assert.equal(calls,2);
  await req(`/jobs/${id}/proposal`,{skip_evaluation:true});assert.equal(db.prepare('SELECT status FROM jobs WHERE rowid=?').get(id).status,'approved');
  await req(`/jobs/${id}/estimate`);assert.equal(db.prepare('SELECT estimate FROM user_jobs WHERE user_id=1 AND job_id=?').get(id).estimate.includes('tasks'),true);
  assert.equal((await req('/jobs/999/evaluate')).status,404);
});

test('estimate handles owner bypass, zero balance, unset prices, and the reported hourly USD job',async(t)=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'estimate-owner-')),db=openDb(path.join(dir,'test.db'));
  db.prepare("INSERT INTO jobs(rowid,source,external_id,title,description,url,budget,status,currency,bid_avg,created_at) VALUES(1744,'freelancer','reported','Flutter app','Build a Flutter app','https://example.test','2-12 USD/hr','sent','USD',6.25,'2026-01-01 00:00:00')").run();
  const key='estimate-owner-test-key-at-least-24-chars', logs=[];
  const api=createServer({db,config:{API_KEY:key,API_HOST:'127.0.0.1',CORS_ORIGINS:[],GEMINI_API_KEY:'fake',GEMINI_MODEL:'fake',SAAS_ENABLED:false,GEMINI_PRICE_PER_MTOK_INPUT:0,GEMINI_PRICE_PER_MTOK_OUTPUT:0},logger:{info(){},warn(...x){logs.push(x)},error(...x){logs.push(x)}},geminiClient:{generate:async()=>({text:JSON.stringify({tasks:[{name:'Build application',hours:8}],total_hours:8,risks:[],questions_for_client:[]}),usage:{model:'fake',inputTokens:10,outputTokens:12}})},sources:[{name:'freelancer'}]});
  const address=await api.listen(0,'127.0.0.1');t.after(async()=>{await api.close();closeDb(db);fs.rmSync(dir,{recursive:true,force:true});});
  const response=await fetch(`http://127.0.0.1:${address.port}/jobs/1744/estimate`,{method:'POST',headers:{'X-API-Key':key}});
  assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
  const payload=await response.json();assert.equal(payload.result.total_hours,8);assert.equal(payload.usage.cost_usd,null);assert.equal(db.prepare('SELECT COUNT(*) n FROM credit_ledger WHERE user_id=1').get().n,0);assert.equal(logs.length,0);
});
