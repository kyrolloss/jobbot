import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, closeDb, ensureUserJob, countByStatus, listJobs, saveProposal, saveScore, setStatus } from '../src/db.js';
import { createServer } from '../src/server.js';
import { createEventBus } from '../src/events.js';
import { fanOutJob } from '../src/user_jobs.js';
import { verifyUserJobs } from '../scripts/verify_user_jobs.js';

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(),'jobbot-user-jobs-')); }
function user(db,id) { db.prepare("INSERT INTO users(id,name,role,status,created_at) VALUES(?,?,'user','active',?)").run(id,`user${id}`,new Date('2026-01-01T00:00:00Z').toISOString()); }
function insertJob(db,{source='freelancer',external='one',title='Flutter app',description='Build a mobile app',status='sent'}={}) {
  db.prepare('INSERT INTO jobs(source,external_id,title,description,url,budget,status,created_at) VALUES(?,?,?,?,?,?,?,?)').run(source,external,title,description,'https://example.test/job','$100',status,'2026-01-01 00:00:00');
  return Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
}

test('legacy user state migration is idempotent and preserves owner status counts', (t) => {
  const dir=tempDir(), filename=path.join(dir,'old.db');
  const old=new DatabaseSync(filename);
  old.exec(`CREATE TABLE jobs(source TEXT,external_id TEXT,title TEXT,description TEXT,url TEXT,budget TEXT,status TEXT,created_at TEXT,proposal TEXT,evaluation TEXT,score REAL,score_line TEXT,applied_at TEXT,estimate TEXT,prototype_url TEXT,PRIMARY KEY(source,external_id));
    INSERT INTO jobs(source,external_id,title,description,url,budget,status,created_at,proposal,score,score_line,applied_at) VALUES
    ('freelancer','a','A','D','U','','sent','2026-01-01 00:00:00','p',8,'good',NULL),
    ('freelancer','b','B','D','U','','applied','2026-01-02 00:00:00','q',6,'ok','2026-01-03 00:00:00'),
    ('freelancer','c','C','D','U','','skipped','2026-01-04 00:00:00',NULL,NULL,NULL,NULL);`);
  old.close();
  const db=openDb(filename);
  t.after(()=>{closeDb(db);fs.rmSync(dir,{recursive:true,force:true});});
  const legacy=db.prepare('SELECT status,COUNT(*) count FROM jobs GROUP BY status ORDER BY status').all();
  const migrated=db.prepare('SELECT status,COUNT(*) count FROM user_jobs WHERE user_id=1 GROUP BY status ORDER BY status').all();
  assert.deepEqual(migrated,legacy);
  assert.equal(db.prepare('SELECT applied_at FROM user_jobs WHERE user_id=1 AND job_id=2').get().applied_at,'2026-01-03T00:00:00.000Z');
  closeDb(db);
  const reopened=openDb(filename);
  assert.equal(reopened.prepare('SELECT COUNT(*) n FROM user_jobs WHERE user_id=1').get().n,3);
  closeDb(reopened);
});

test('users have independent state and API listing, detail, counts, and actions are scoped', async (t) => {
  const dir=tempDir(), db=openDb(path.join(dir,'api.db'));
  user(db,2); user(db,3);
  const jobId=insertJob(db);
  ensureUserJob(2,jobId,{status:'sent'},db);
  const key='user-jobs-test-key-at-least-24-characters';
  const api=createServer({db,config:{API_KEY:key,API_HOST:'127.0.0.1',CORS_ORIGINS:[]},authProviders:[(request)=>{
    const supplied=request.headers['x-api-key'];
    if(supplied==='user-two')return {userId:2,role:'user',planId:'free'};
    if(supplied==='user-three')return {userId:3,role:'user',planId:'free'};
    if(supplied===key)return {userId:1,role:'owner',planId:'owner'};
    return null;
  }]});
  const address=await api.listen(0,'127.0.0.1'), base=`http://127.0.0.1:${address.port}`;
  t.after(async()=>{await api.close();closeDb(db);fs.rmSync(dir,{recursive:true,force:true});});
  const req=(route,auth,method='GET')=>fetch(base+route,{method,headers:{'X-API-Key':auth}});
  assert.equal((await req('/jobs','user-three')).status,200);
  const user3List=await (await req('/jobs','user-three')).json(); assert.equal(user3List.total,0);
  assert.equal((await req(`/jobs/${jobId}`,'user-three')).status,404);
  assert.equal((await req(`/jobs/${jobId}/reject`,'user-three','POST')).status,404);
  assert.equal((await req(`/jobs/${jobId}/reject`,'user-two','POST')).status,200);
  assert.equal(db.prepare('SELECT status FROM user_jobs WHERE user_id=2 AND job_id=?').get(jobId).status,'rejected');
  assert.equal(db.prepare('SELECT status FROM user_jobs WHERE user_id=1 AND job_id=?').get(jobId).status,'sent');
  assert.equal(db.prepare('SELECT status FROM jobs WHERE rowid=?').get(jobId).status,'sent');
  assert.equal((await (await req('/stats/counts','user-two')).json()).by_status.rejected,1);
  assert.equal((await (await req('/jobs','user-two')).json()).total,1);
});

test('fan-out obeys SaaS and source policy and uses per-user keywords', (t) => {
  const dir=tempDir(),db=openDb(path.join(dir,'fanout.db'));
  t.after(()=>{closeDb(db);fs.rmSync(dir,{recursive:true,force:true});});
  user(db,2);
  db.prepare("INSERT INTO user_profiles(user_id,keywords,updated_at) VALUES(2,'[\"specialterm\"]',?)").run(new Date().toISOString());
  const freelancer=insertJob(db,{external:'f',title:'SpecialTerm delivery',description:'A custom project'});
  const onlyOwner=fanOutJob({db,rowid:freelancer,job:{source:'freelancer',title:'SpecialTerm delivery',description:'A custom project'},status:'sent',config:{SAAS_ENABLED:false}});
  assert.deepEqual(onlyOwner,[1]);
  assert.equal(db.prepare('SELECT 1 FROM user_jobs WHERE user_id=2 AND job_id=?').get(freelancer),undefined);
  const freelancer2=insertJob(db,{external:'f2',title:'SpecialTerm delivery'});
  const recipients=fanOutJob({db,rowid:freelancer2,job:{source:'freelancer',title:'SpecialTerm delivery',description:'A custom project'},stats:{},status:'sent',config:{SAAS_ENABLED:true,SOURCE_POLICY:{freelancer:{saas:true},mostaql:{saas:false},khamsat:{saas:false}}}});
  assert.deepEqual(recipients,[1,2]);
  assert.ok(db.prepare('SELECT score FROM user_jobs WHERE user_id=2 AND job_id=?').get(freelancer2));
  const mostaql=insertJob(db,{source:'mostaql',external:'m',title:'SpecialTerm'});
  fanOutJob({db,rowid:mostaql,job:{source:'mostaql',title:'SpecialTerm'},config:{SAAS_ENABLED:true,SOURCE_POLICY:{mostaql:{saas:false}}}});
  assert.equal(db.prepare('SELECT 1 FROM user_jobs WHERE user_id=2 AND job_id=?').get(mostaql),undefined);
  const khamsat=insertJob(db,{source:'khamsat',external:'k',title:'SpecialTerm'});
  fanOutJob({db,rowid:khamsat,job:{source:'khamsat',title:'SpecialTerm'},config:{SAAS_ENABLED:true,SOURCE_POLICY:{khamsat:{saas:false}}}});
  assert.equal(db.prepare('SELECT 1 FROM user_jobs WHERE user_id=2 AND job_id=?').get(khamsat),undefined);
  const filtered=insertJob(db,{external:'filtered',title:'Flutter only'});
  fanOutJob({db,rowid:filtered,job:{source:'freelancer',title:'Flutter only'},config:{SAAS_ENABLED:true,SOURCE_POLICY:{freelancer:{saas:true}}}});
  assert.equal(db.prepare('SELECT 1 FROM user_jobs WHERE user_id=2 AND job_id=?').get(filtered),undefined);
});

test('owner updates mirror to jobs while other users never write legacy state', (t) => {
  const dir=tempDir(),db=openDb(path.join(dir,'mirror.db'));
  t.after(()=>{closeDb(db);fs.rmSync(dir,{recursive:true,force:true});});
  user(db,2);
  const id=insertJob(db); ensureUserJob(2,id,{status:'sent'},db);
  const job=db.prepare('SELECT source,external_id FROM jobs WHERE rowid=?').get(id);
  saveScore(job,9,'owner score'); saveProposal(id,'owner proposal');
  assert.deepEqual({...db.prepare('SELECT score,score_line,proposal FROM jobs WHERE rowid=?').get(id)},{score:9,score_line:'owner score',proposal:'owner proposal'});
  setStatus(job,'rejected',db,2);
  saveProposal(id,'user two proposal',true,2); saveScore(job,2,'user two score',2);
  assert.deepEqual({...db.prepare('SELECT status,score,score_line,proposal FROM jobs WHERE rowid=?').get(id)},{status:'sent',score:9,score_line:'owner score',proposal:'owner proposal'});
});

test('SSE replay filters events by user and verifier detects legacy mirror drift', async (t) => {
  const dir=tempDir(),db=openDb(path.join(dir,'sse.db'));
  const id=insertJob(db); user(db,2); ensureUserJob(2,id,{status:'sent'},db);
  const events=createEventBus(); events.emit('new_job',{user_id:1,secret:'owner-only'}); events.emit('new_job',{user_id:2,secret:'user-two'});
  const key='user-jobs-sse-test-key-at-least-24-chars';
  const api=createServer({db,events,config:{API_KEY:key,API_HOST:'127.0.0.1',CORS_ORIGINS:[]},authProviders:[(request)=>request.headers['x-api-key']==='user-two'?{userId:2,role:'user',planId:'free'}:null]});
  const address=await api.listen(0,'127.0.0.1');
  t.after(async()=>{await api.close();closeDb(db);fs.rmSync(dir,{recursive:true,force:true});});
  const response=await fetch(`http://127.0.0.1:${address.port}/events`,{headers:{'X-API-Key':'user-two','Last-Event-ID':'0'}});
  const reader=response.body.getReader();
  let text='';
  while(!text.includes('"secret":"user-two"')) { const {value,done}=await reader.read(); assert.equal(done,false); text+=new TextDecoder().decode(value); }
  assert.ok(!text.includes('owner-only'));
  await reader.cancel();
  assert.equal(verifyUserJobs(path.join(dir,'sse.db')).ok,true);
  db.prepare("UPDATE user_jobs SET proposal='broken' WHERE user_id=1 AND job_id=?").run(id);
  assert.equal(verifyUserJobs(path.join(dir,'sse.db')).ok,false);
});
