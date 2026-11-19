import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root=resolve(import.meta.dirname,'..');
const dir=mkdtempSync(join(tmpdir(),'revalo-tests-'));
const port=34000+Math.floor(Math.random()*1500);
const url=`http://127.0.0.1:${port}`;
const child=spawn(process.execPath,['--experimental-sqlite','server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DB_PATH:join(dir,'test.sqlite'),PILOT_CODE:'TEST-CODE-2026',NODE_ENV:'development'},stdio:['ignore','pipe','pipe']});
let logs='';child.stdout.on('data',d=>logs+=String(d));child.stderr.on('data',d=>logs+=String(d));
async function ready(){for(let i=0;i<80;i++){try{const r=await fetch(url+'/health');if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,70));}throw Error('Server did not start: '+logs)};
const api=async(path,method='GET',body,cookie,origin)=>{const headers={};if(body!==undefined)headers['content-type']='application/json';if(cookie)headers.cookie=cookie;if(origin)headers.origin=origin;const r=await fetch(url+path,{method,headers,body:body!==undefined?JSON.stringify(body):undefined});let value;const text=await r.text();try{value=JSON.parse(text);}catch{value=text;}return {status:r.status,body:value,cookie:r.headers.get('set-cookie')};};
const contract={client:'Entreprise test A',reference:'NET-001',monthly_price:1200,anniversary:'2026-12-15',index_name:'Indice contrat exemple',index_source_url:'https://www.insee.fr/fr/information/1300606',base_index:100,new_index:104,formula:'ratio',fixed_share:0,clause_confirmed:true};

test('registre des contrats TPE, isolation et bilan', {timeout:20000},async()=>{
  await ready();
  const health=await api('/health');assert.equal(health.body.ok,true);
  const invalid=await api('/api/auth/register','POST',{email:'a@example.com',password:'password-too-short',code:'wrong'});assert.equal(invalid.status,403);
  const r1=await api('/api/auth/register','POST',{email:'a@example.com',password:'SensiblePassword!2026',code:'TEST-CODE-2026'});
  assert.equal(r1.status,201);const c1=r1.cookie.split(';')[0];assert.ok(c1.includes('rv_session='));
  const r2=await api('/api/auth/register','POST',{email:'b@example.com',password:'AnotherLongPassword2026!',code:'TEST-CODE-2026'});
  assert.equal(r2.status,201);const c2=r2.cookie.split(';')[0];
  const noAuth=await api('/api/contracts');assert.equal(noAuth.status,401);
  const csrf=await api('/api/contracts','POST',contract,c1,'https://evil.test');assert.equal(csrf.status,403);
  const draft=await api('/api/contracts','POST',{...contract,reference:'NET-000',clause_confirmed:false},c1);assert.equal(draft.status,201);
  const prohibited=await api(`/api/contracts/${draft.body.id}/revision`,'POST',{},c1);assert.equal(prohibited.status,422);
  const created=await api('/api/contracts','POST',contract,c1);assert.equal(created.status,201);
  assert.equal(created.body.calculation.old_cents,120000);assert.equal(created.body.calculation.new_cents,124800);assert.equal(created.body.calculation.delta_cents,4800);assert.equal(created.body.calculation.annual_delta_cents,57600);
  const duplicate=await api('/api/contracts','POST',contract,c1);assert.equal(duplicate.status,409);
  const bView=await api('/api/contracts','GET',undefined,c2);assert.equal(bView.body.contracts.length,0);
  const bDel=await api(`/api/contracts/${created.body.id}`,'DELETE',{},c2);assert.equal(bDel.status,404);
  const rev=await api(`/api/contracts/${created.body.id}/revision`,'POST',{},c1);assert.equal(rev.status,201);
  const rev2=await api(`/api/contracts/${created.body.id}/revision`,'POST',{},c1);assert.equal(rev2.status,409);
  const fast=await api(`/api/revisions/${rev.body.id}`,'PATCH',{status:'collected',evidence_ref:'TRX1234'},c1);assert.equal(fast.status,422);
  const noEvidence=await api(`/api/revisions/${rev.body.id}`,'PATCH',{status:'requested'},c1);assert.equal(noEvidence.status,200);
  for(const status of ['approved','invoiced']){const m=await api(`/api/revisions/${rev.body.id}`,'PATCH',{status},c1);assert.equal(m.status,200,status);}
  const badCollected=await api(`/api/revisions/${rev.body.id}`,'PATCH',{status:'collected'},c1);assert.equal(badCollected.status,422);
  const collected=await api(`/api/revisions/${rev.body.id}`,'PATCH',{status:'collected',evidence_ref:'TRX1234'},c1);assert.equal(collected.status,200);
  const result=await api('/api/contracts','GET',undefined,c1);assert.equal(result.body.contracts.length,2);assert.equal(result.body.revisions.length,1);assert.equal(result.body.revisions[0].status,'collected');
  const csv=await api('/api/export.csv','GET',undefined,c1);assert.equal(csv.status,200);assert.ok(csv.body.includes('NET-001'));
  const calendar=await api('/api/calendar.ics','GET',undefined,c1);assert.equal(calendar.status,200);assert.ok(calendar.body.includes('BEGIN:VCALENDAR'));
  const logout=await api('/api/auth/logout','POST',{},c1);assert.equal(logout.status,200);
  const again=await api('/api/contracts','GET',undefined,c1);assert.equal(again.status,401);
});

test('prix et formules fiables: proportion et part fixe',{timeout:10000},async()=>{
  const login=await api('/api/auth/login','POST',{email:'b@example.com',password:'AnotherLongPassword2026!'});assert.equal(login.status,200);const c=login.cookie.split(';')[0];
  const weighted=await api('/api/contracts','POST',{...contract,reference:'MAI-017',formula:'weighted',fixed_share:0.1},c);assert.equal(weighted.status,201);assert.equal(weighted.body.calculation.new_cents,124320);assert.equal(weighted.body.calculation.delta_cents,4320);
  const bad=await api('/api/contracts','POST',{...contract,reference:'INC-002',base_index:0},c);assert.equal(bad.status,422);
});

test('cleanup and stop server',async()=>{child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));rmSync(dir,{recursive:true,force:true});});