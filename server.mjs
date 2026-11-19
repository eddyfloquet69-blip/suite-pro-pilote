import http from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

class ValidationError extends Error {}
const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || resolve(process.cwd(), 'data', 'revalo.sqlite');
const HOST = process.env.HOST || '0.0.0.0';
const PILOT_CODE = process.env.PILOT_CODE || '';
const MODE = process.env.MODE || 'pilot';
const MAX_BODY = 40_000;
const SESSION_DAYS = 10;
const STATUSES = ['prepared', 'requested', 'approved', 'invoiced', 'collected'];

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS contracts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client TEXT NOT NULL,
    reference TEXT NOT NULL,
    monthly_price_cents INTEGER NOT NULL CHECK(monthly_price_cents >= 0),
    anniversary TEXT NOT NULL,
    index_name TEXT NOT NULL,
    index_source_url TEXT NOT NULL DEFAULT '',
    base_index REAL NOT NULL CHECK(base_index > 0),
    new_index REAL NOT NULL CHECK(new_index > 0),
    formula TEXT NOT NULL DEFAULT 'ratio',
    fixed_share REAL NOT NULL DEFAULT 0 CHECK(fixed_share >= 0 AND fixed_share <= 1),
    clause_confirmed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(user_id, reference)
  );
  CREATE TABLE IF NOT EXISTS revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    anniversary TEXT NOT NULL,
    old_cents INTEGER NOT NULL,
    new_cents INTEGER NOT NULL,
    delta_cents INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'prepared',
    evidence_ref TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    UNIQUE(contract_id, anniversary)
  );
  CREATE INDEX IF NOT EXISTS idx_contracts_user ON contracts(user_id, anniversary);
  CREATE INDEX IF NOT EXISTS idx_revisions_user ON revisions(user_id);
`);
const now = () => new Date().toISOString();
const sha = (value) => createHash('sha256').update(value).digest('hex');
const saltHash = (pass,salt) => scryptSync(pass,salt,64).toString('hex');
const timingEqual = (a,b) => {const x=Buffer.from(a);const y=Buffer.from(b);return x.length===y.length && timingSafeEqual(x,y);};
const euroCents = n => {const v=Number(n);if(!Number.isFinite(v)||v<0||v>1_000_000)return null;return Math.round((v+Number.EPSILON)*100);};
const dateOkay = d => typeof d==='string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(d+'T12:00:00Z').toISOString().slice(0,10)===d;
const limited = (x,max=180) => String(x??'').trim().slice(0,max);
const emailOK = x => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x) && x.length<=254;
const num = (v,min,max) => {const x=Number(v);return Number.isFinite(x)&&x>=min&&x<=max?x:null;};
const query = (sql,...params) => db.prepare(sql).all(...params);
const one = (sql,...params) => db.prepare(sql).get(...params);
const run = (sql,...params) => db.prepare(sql).run(...params);
const json = (data,status=200,headers={}) => ({status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers},body:JSON.stringify(data)});
const fail = (code,message) => json({error:message},code);
const needsAuth = (user) => user?null:fail(401,'Connexion requise.');
const cookieHeader = token => `rv_session=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS*86400}`;
const deleteCookie = 'rv_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
const getToken = request => {const m=(request.headers.cookie||'').match(/(?:^|;\s*)rv_session=([^;]+)/);return m?decodeURIComponent(m[1]):'';};
const userFor = req => {const token=getToken(req);if(!token)return null;return one('SELECT users.id, users.email FROM users JOIN sessions ON sessions.user_id=users.id WHERE sessions.token_hash=? AND sessions.expires_at>?',sha(token),Date.now())||null;};
const newSession = userId => {const token=randomBytes(32).toString('base64url');run('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)',sha(token),userId,Date.now()+SESSION_DAYS*86400_000);return token;};
const originOkay = req => {const origin=req.headers.origin;if(!origin)return req.headers['sec-fetch-site']!=='cross-site';try{return new URL(origin).host === req.headers.host;}catch{return false;}};
const ipCount=new Map();
function rateLimit(req,route){const addr=req.socket.remoteAddress||'unknown';const key=addr+route;const stamp=Date.now();let hit=ipCount.get(key);if(!hit||hit.reset<stamp){hit={count:0,reset:stamp+15*60_000};}hit.count++;ipCount.set(key,hit);if(ipCount.size>5000)ipCount.clear();return hit.count<=25;}
async function readJson(req){return new Promise((resolve,reject)=>{let text='';req.on('data',buf=>{text+=buf;if(text.length>MAX_BODY){reject(new Error('Trop de données'));req.destroy();}});req.on('end',()=>{try{resolve(JSON.parse(text||'{}'))}catch{reject(new Error('JSON invalide'))}});req.on('error',reject);});}
function calc(c){
  const k = Number(c.base_index), n=Number(c.new_index), a=Number(c.fixed_share);
  if(!Number.isFinite(k)||!Number.isFinite(n)||k<=0||n<=0||!Number.isFinite(a)||a<0||a>1) throw Error('Indice ou part fixe invalide');
  const coeff=c.formula==='weighted'?a+(1-a)*n/k:n/k;
  const currentCents=Number(c.monthly_price_cents);
  const revisedCents=Math.round(currentCents*coeff);
  return {coefficient:Math.round(coeff*1e6)/1e6,old_cents:currentCents,new_cents:revisedCents,delta_cents:revisedCents-currentCents,annual_delta_cents:(revisedCents-currentCents)*12};
}
function contractFromRequest(x){
  const client=limited(x.client,160),reference=limited(x.reference,90),anniversary=limited(x.anniversary,10),index_name=limited(x.index_name,120),index_source_url=limited(x.index_source_url,500);
  const money=euroCents(x.monthly_price),base=num(x.base_index,0.00001,1000000),next=num(x.new_index,0.00001,1000000),formula=x.formula==='weighted'?'weighted':'ratio',fixed_share=formula==='weighted'?num(x.fixed_share,0,1):0;
  if(!client||!reference||!dateOkay(anniversary)||!index_name||money===null||base===null||next===null||fixed_share===null) throw new ValidationError('Complétez les champs du contrat et les valeurs d’indices valides.');
  if(index_source_url && (!index_source_url.startsWith('https://')||index_source_url.length>500))throw new ValidationError('Source : saisissez une URL HTTPS officielle ou laissez vide.');
  return {client,reference,anniversary,index_name,index_source_url,monthly_price_cents:money,base_index:base,new_index:next,formula,fixed_share,clause_confirmed:x.clause_confirmed===true?1:0};
}
function revRows(userId){return query('SELECT r.*, c.client, c.reference FROM revisions r JOIN contracts c ON c.id=r.contract_id WHERE r.user_id=? ORDER BY r.updated_at DESC',userId);}
const appHtml = readFileSync(new URL('./public/app.html',import.meta.url));
async function router(req){
  const url=new URL(req.url,'http://'+(req.headers.host||'localhost'));
  const path=url.pathname,method=req.method||'GET';
  if(path==='/health')return json({ok:true,product:'Revalo TPE',mode:MODE});
  if(path==='/')return {status:200,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",'x-frame-options':'DENY','referrer-policy':'no-referrer'},body:appHtml};
  if(path==='/robots.txt')return {status:200,headers:{'content-type':'text/plain; charset=utf-8'},body:'User-agent: *\nDisallow: /\n'};
  if(!path.startsWith('/api/'))return fail(404,'Introuvable');
  if(!['GET','POST','PATCH','DELETE'].includes(method))return fail(405,'Méthode non autorisée');
  if(method!=='GET'&&!originOkay(req))return fail(403,'Origine non autorisée');
  let body={};if(['POST','PATCH','DELETE'].includes(method))body=await readJson(req);
  const user=userFor(req);
  if(path==='/api/auth/register'&&method==='POST'){
    if(!PILOT_CODE)return fail(403,'Inscriptions fermées pour cette préversion.');
    if(!rateLimit(req,path))return fail(429,'Trop de tentatives, réessayez plus tard.');
    const email=limited(body.email,254).toLowerCase(),password=String(body.password||''),code=String(body.code||'');
    if(!emailOK(email)||password.length<12||password.length>128)return fail(422,'Email ou mot de passe invalide (12 caractères minimum).');
    if(!timingEqual(code,PILOT_CODE))return fail(403,'Code pilote invalide.');
    if(one('SELECT id FROM users WHERE email=?',email))return fail(409,'Compte déjà existant.');
    const salt=randomBytes(16).toString('hex');const inserted=run('INSERT INTO users(email,salt,password_hash,created_at) VALUES (?,?,?,?)',email,salt,saltHash(password,salt),now());
    const token=newSession(Number(inserted.lastInsertRowid));return json({ok:true,email},201,{'set-cookie':cookieHeader(token)});
  }
  if(path==='/api/auth/login'&&method==='POST'){
    if(!rateLimit(req,path))return fail(429,'Trop de tentatives, réessayez plus tard.');
    const email=limited(body.email,254).toLowerCase(),password=String(body.password||'');
    if(password.length>128)return fail(401,'Identifiants incorrects.');
    const found=one('SELECT * FROM users WHERE email=?',email);
    const d=found?found.password_hash:saltHash('invalid-password','a'.repeat(32));const s=found?found.salt:'a'.repeat(32);
    if(!found||!timingEqual(d,saltHash(password,s)))return fail(401,'Identifiants incorrects.');
    return json({ok:true,email},200,{'set-cookie':cookieHeader(newSession(found.id))});
  }
  if(path==='/api/auth/logout'&&method==='POST'){
    const token=getToken(req);if(token)run('DELETE FROM sessions WHERE token_hash=?',sha(token));
    return json({ok:true},200,{'set-cookie':deleteCookie});
  }
  if(path==='/api/me'&&method==='GET')return json({user:user?{email:user.email}:null,registration_open:!!PILOT_CODE});
  if(needsAuth(user))return needsAuth(user);
  if(path==='/api/account'&&method==='DELETE'){
    const password=String(body.password||'');
    if(password.length>128)return fail(401,'Mot de passe incorrect.');
    const found=one('SELECT password_hash,salt FROM users WHERE id=?',user.id);
    if(!found||!timingEqual(found.password_hash,saltHash(password,found.salt)))return fail(401,'Mot de passe incorrect.');
    run('DELETE FROM users WHERE id=?',user.id);
    return json({ok:true,deleted:true},200,{'set-cookie':deleteCookie});
  }
  if(path==='/api/contracts'&&method==='GET'){
    const rows=query('SELECT * FROM contracts WHERE user_id=? ORDER BY anniversary ASC,id DESC',user.id);
    return json({contracts:rows.map(x=>({...x,calculation:calc(x)})),revisions:revRows(user.id)});
  }
  if(path==='/api/contracts'&&method==='POST'){
    const c=contractFromRequest(body);
    if(query('SELECT id FROM contracts WHERE user_id=?',user.id).length>=150)return fail(422,'Limite pilote : 150 contrats par compte.');
    try{const r=run(`INSERT INTO contracts(user_id,client,reference,monthly_price_cents,anniversary,index_name,index_source_url,base_index,new_index,formula,fixed_share,clause_confirmed,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,user.id,c.client,c.reference,c.monthly_price_cents,c.anniversary,c.index_name,c.index_source_url,c.base_index,c.new_index,c.formula,c.fixed_share,c.clause_confirmed,now(),now());return json({id:Number(r.lastInsertRowid),calculation:calc(c)},201);}catch(e){if(String(e).includes('UNIQUE'))return fail(409,'Référence de contrat déjà utilisée.');throw e;}
  }
  const m=path.match(/^\/api\/contracts\/(\d+)$/);
  if(m&&method==='DELETE'){
    const exists=run('DELETE FROM contracts WHERE id=? AND user_id=?',Number(m[1]),user.id);return exists.changes?json({ok:true}):fail(404,'Contrat introuvable');
  }
  if(m&&method==='PATCH'){
    const id=Number(m[1]);const exists=one('SELECT * FROM contracts WHERE id=? AND user_id=?',id,user.id);if(!exists)return fail(404,'Contrat introuvable');
    const c=contractFromRequest(body);
    if(one('SELECT id FROM revisions WHERE contract_id=? AND user_id=?',id))return fail(409,'Contrat déjà révisé : supprimez la révision avant de changer sa base.');
    try{run(`UPDATE contracts SET client=?,reference=?,monthly_price_cents=?,anniversary=?,index_name=?,index_source_url=?,base_index=?,new_index=?,formula=?,fixed_share=?,clause_confirmed=?,updated_at=? WHERE id=? AND user_id=?`,c.client,c.reference,c.monthly_price_cents,c.anniversary,c.index_name,c.index_source_url,c.base_index,c.new_index,c.formula,c.fixed_share,c.clause_confirmed,now(),id,user.id);return json({ok:true,calculation:calc(c)});}catch(e){if(String(e).includes('UNIQUE'))return fail(409,'Référence déjà utilisée');throw e;}
  }
  const sub=path.match(/^\/api\/contracts\/(\d+)\/revision$/);
  if(sub&&method==='POST'){
    const c=one('SELECT * FROM contracts WHERE id=? AND user_id=?',Number(sub[1]),user.id);if(!c)return fail(404,'Contrat introuvable');
    if(!c.clause_confirmed)return fail(422,'Vérifiez d’abord la clause de révision prévue au contrat.');
    const old=one('SELECT id FROM revisions WHERE contract_id=? AND anniversary=?',c.id,c.anniversary);
    if(old)return fail(409,'Cette échéance possède déjà une révision.');
    const total=calc(c),ts=now();const o=run('INSERT INTO revisions(contract_id,user_id,anniversary,old_cents,new_cents,delta_cents,status,updated_at) VALUES (?,?,?,?,?,?,?,?)',c.id,user.id,c.anniversary,total.old_cents,total.new_cents,total.delta_cents,'prepared',ts);return json({id:Number(o.lastInsertRowid),...total},201);
  }
  const rv=path.match(/^\/api\/revisions\/(\d+)$/);
  if(rv&&method==='PATCH'){
    const id=Number(rv[1]);const row=one('SELECT r.*, c.client, c.reference FROM revisions r JOIN contracts c ON c.id=r.contract_id WHERE r.id=? AND r.user_id=?',id,user.id);if(!row)return fail(404,'Révision introuvable');
    const status=limited(body.status,12);if(!STATUSES.includes(status))return fail(422,'Statut incorrect.');
    if(STATUSES.indexOf(status)!==STATUSES.indexOf(row.status)+1)return fail(422,'Suivez les étapes dans l’ordre.');
    if(status==='collected'&&limited(body.evidence_ref,140).length<5)return fail(422,'Référence d’un paiement requis pour déclarer encaissé.');
    const ref=limited(body.evidence_ref,140)||row.evidence_ref;run('UPDATE revisions SET status=?,evidence_ref=?,updated_at=? WHERE id=? AND user_id=?',status,ref,now(),id,user.id);return json({ok:true,status});
  }
  if(rv&&method==='DELETE'){
    const d=run('DELETE FROM revisions WHERE id=? AND user_id=?',Number(rv[1]),user.id);return d.changes?json({ok:true}):fail(404,'Introuvable');
  }
  if(path==='/api/calendar.ics'&&method==='GET'){
    const rows=query('SELECT client,reference,anniversary FROM contracts WHERE user_id=? ORDER BY anniversary',user.id);
    const esc=x=>String(x).replace(/\\/g,'\\\\').replace(/[\r\n]/g,'\\n').replace(/,/g,'\\,').replace(/;/g,'\\;');
    const events=rows.map(x=>`BEGIN:VEVENT\r\nUID:${sha(user.id+'-'+x.reference+'-'+x.anniversary)}@revalo-tpe\r\nDTSTART;VALUE=DATE:${x.anniversary.replaceAll('-','')}\r\nSUMMARY:${esc('Vérifier révision : '+x.client)}\r\nDESCRIPTION:${esc('Contrat '+x.reference+' — vérifier clause et indice avant notification')}\r\nEND:VEVENT`).join('\r\n');
    return {status:200,headers:{'content-type':'text/calendar; charset=utf-8','content-disposition':'attachment; filename="revisions.ics"','cache-control':'no-store'},body:'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//REVALO-TPE//PILOTE//FR\r\n'+events+'\r\nEND:VCALENDAR'};
  }
  if(path==='/api/export.csv'&&method==='GET'){
    const rows=query('SELECT client,reference,anniversary,monthly_price_cents,index_name,base_index,new_index,formula,fixed_share,clause_confirmed FROM contracts WHERE user_id=? ORDER BY anniversary',user.id);
    const esc=x=>{let value=String(x??'');if(/^[=+@-]/.test(value))value="'"+value;return '"'+value.replaceAll('"','""')+'"';};
    const cols=['client','reference','anniversary','monthly_price_cents','index_name','base_index','new_index','formula','fixed_share','clause_confirmed'];
    const csv=[cols.join(';'),...rows.map(r=>cols.map(c=>esc(r[c])).join(';'))].join('\r\n');
    return {status:200,headers:{'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="contrats.csv"','cache-control':'no-store'},body:'\uFEFF'+csv};
  }
  return fail(404,'Route inconnue');
}
function send(res,r){res.writeHead(r.status??200,{'x-content-type-options':'nosniff','referrer-policy':'no-referrer',...r.headers});res.end(r.body);}
export const server=http.createServer(async(req,res)=>{try{const r=await router(req);send(res,r)}catch(e){console.error('Request failed:',String(e?.message||e).slice(0,180));send(res,fail(e instanceof ValidationError?422:500,e instanceof ValidationError?e.message:'Impossible de traiter cette demande.'));}});
if(process.env.NODE_ENV!=='test'){server.listen(PORT,HOST,()=>console.log('revalo-tpe listening',PORT));}