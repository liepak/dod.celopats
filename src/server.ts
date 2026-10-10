import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Store, randomToken } from './store.ts';
import { Drive, AppError, isMedia, normalizeMime } from './drive.ts';

const root = dirname(fileURLToPath(import.meta.url));
const CHUNK = 8 * 1024 * 1024;
const MAX_FILE = 10 * 1024 ** 3;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const clean = (s: unknown, max = 120) => typeof s === 'string' ? s.trim().replace(/[\x00-\x1f\x7f]/g,'').slice(0,max) : '';
const publicCollection = c => ({name:c.name,description:c.description,uploadsOpen:!!c.uploads_open,maxFileSize:MAX_FILE,chunkSize:CHUNK});

export function createApp({dir = process.env.DATA_DIR || './data', origin = process.env.PUBLIC_ORIGIN || 'http://localhost:3000', driveFactory = (s: Store) => new Drive(s)} = {}) {
  const store = new Store(dir), db = store.db, drive = driveFactory(store);
  if (!store.get('password')) {
    const initial = randomToken(); store.setPassword(initial);
    writeFileSync(join(dir,'owner-access.txt'),`Owner dashboard: ${origin}/admin\nPassword: ${initial}\nChange this password after signing in. Keep this file private.\n`,{mode:0o600});
  }
  const limits = new Map<string, {count:number, expires:number}>(), locks = new Set<string>();
  function limit(key: string, count: number, ms = 60000) {
    const now=Date.now(); let v=limits.get(key);
    if (!v || v.expires < now) {v={count:0,expires:now+ms};limits.set(key,v);}
    if (++v.count > count) throw new AppError(429,'Too many requests. Please wait a minute and try again.');
    if (limits.size>5000) for (const [k,v] of limits) if(v.expires<now) limits.delete(k);
  }
  async function body(req, max = 32768) {
    let size=0; const parts=[];
    for await (const p of req) {size+=p.length;if(size>max) throw new AppError(413,'This upload chunk is too large.');parts.push(p);}
    return Buffer.concat(parts);
  }
  async function jsonBody(req) {try{return JSON.parse((await body(req)).toString());}catch(e){if(e instanceof AppError)throw e;throw new AppError(400,'Please check the submitted information.');}}
  const json = (res, value, status = 200) => {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
  function session(req) {
    const cookie = req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('dod_session='))?.slice(12);
    if (!cookie || !/^[A-Za-z0-9_-]{43}$/.test(cookie)) return null;
    return db.prepare('SELECT * FROM sessions WHERE id=? AND expires>?').get(hash(cookie),Date.now());
  }
  function admin(req) {const s=session(req);if(!s)throw new AppError(401,'Please sign in to manage collections.');return s;}
  function sameOrigin(req) {
    if(req.headers.origin!==origin) throw new AppError(403,'Please use the collection page to perform this action.');
  }
  function collection(token: string) {
    if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw new AppError(404,'This collection link is unavailable.');
    const c=db.prepare('SELECT * FROM collections WHERE token=? AND active=1').get(token);
    if(!c)throw new AppError(404,'This collection link has been closed or replaced.');return c;
  }
  function canUpload(c) {if(!c.uploads_open)throw new AppError(403,'Uploads are closed. You can still view and download the collection.');}
  async function reconcile(u, c) {
    if(u.state==='done')return {id:u.id,offset:u.size,done:true};
    // A lost response after the final chunk must not create a second Drive file.
    try {
      const f=await drive.metadata(u.file_id);
      if(f.parents?.includes(c.folder) && Number(f.size)===u.size && !f.trashed) {
        db.prepare("UPDATE uploads SET state='done',offset=size,session=NULL WHERE id=?").run(u.id);
        return {id:u.id,offset:u.size,done:true};
      }
    } catch(e) {if(!(e instanceof AppError) || e.status!==404)throw e;}
    if(!u.session) {
      canUpload(c);
      const uri=await drive.begin(c.folder,u);
      db.prepare("UPDATE uploads SET session=?,state='uploading' WHERE id=?").run(store.seal(uri),u.id);
      return {id:u.id,offset:0,done:false};
    }
    try {
      const result=await drive.session(store.open(u.session),u.size);
      await confirm(u,c,result);return {id:u.id,offset:result.offset,done:result.done};
    } catch(e) {
      if(e instanceof AppError && e.status===410) {
        db.prepare("UPDATE uploads SET state='expired',session=NULL WHERE id=?").run(u.id);
      }
      throw e;
    }
  }
  async function confirm(u,c,r) {
    if(r.done) {
      const f=await drive.metadata(u.file_id);
      if(f.trashed || !f.parents?.includes(c.folder) || Number(f.size)!==u.size)throw new AppError(502,'The uploaded file could not be verified in Google Drive.');
      db.prepare("UPDATE uploads SET state='done',offset=size,session=NULL WHERE id=?").run(u.id);
    } else {
      if(!Number.isSafeInteger(r.offset) || r.offset<0 || r.offset>u.size)throw new AppError(502,'Google Drive returned invalid upload progress.');
      db.prepare('UPDATE uploads SET offset=? WHERE id=?').run(r.offset,u.id);
    }
  }
  const server=createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Robots-Tag','noindex, nofollow, noarchive');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' https://apis.google.com https://*.google.com https://www.gstatic.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://*.googleapis.com https://*.google.com; frame-src https://*.google.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url=new URL(req.url,origin), path=url.pathname, method=req.method;
      const ip=req.socket.remoteAddress || 'unknown';
      if(path==='/health' && method==='GET')return json(res,{ok:true});
      if(path==='/api/login' && method==='POST') {
        sameOrigin(req);limit('login:'+ip,8,15*60000);
        const b=await jsonBody(req);
        if(typeof b.password!=='string'||b.password.length>200||!store.checkPassword(b.password))throw new AppError(401,'That password did not match.');
        const id=randomToken(),csrf=randomToken();db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
        db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(id),Date.now()+12*3600000,csrf);
        res.setHeader('Set-Cookie',`dod_session=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${origin.startsWith('https:')?'; Secure':''}`);
        return json(res,{csrf});
      }
      if(path==='/oauth/callback' && method==='GET') {
        const s=admin(req),pending=store.get('oauthPending');
        if(!pending||pending.session!==s.id||pending.expires<Date.now()||pending.state!==url.searchParams.get('state'))throw new AppError(400,'Google sign-in expired. Start again from your dashboard.');
        store.set('oauthPending',null);
        if(url.searchParams.has('error')){res.writeHead(303,{Location:'/admin?google=cancelled'});return res.end();}
        const conf=store.get('google');
        const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({client_id:conf.clientId,client_secret:conf.clientSecret,code:url.searchParams.get('code')||'',redirect_uri:origin+'/oauth/callback',code_verifier:pending.verifier,grant_type:'authorization_code'}),signal:AbortSignal.timeout(20000)});
        if(!r.ok)throw new AppError(400,'Google connection failed. Please try connecting again.');
        const tokens=await r.json();
        const identity=await fetch('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:`Bearer ${tokens.access_token}`},signal:AbortSignal.timeout(20000)});
        if(!identity.ok)throw new AppError(400,'Could not verify the connected Google account.');
        const profile=await identity.json();
        if(!profile.email_verified||profile.email?.toLowerCase()!==conf.ownerEmail.toLowerCase())throw new AppError(403,'Connect the Google account configured in your dashboard.');
        const previous=store.get('oauth');
        if(previous?.sub && previous.sub!==profile.sub)throw new AppError(403,'This app is already linked to a different Drive owner.');
        const refresh_token=tokens.refresh_token||previous?.refresh_token;
        if(!refresh_token)throw new AppError(400,'Google did not grant background access. Try connecting again.');
        store.set('oauth',{refresh_token,email:profile.email,sub:profile.sub});drive.access=tokens.access_token;drive.expires=Date.now()+tokens.expires_in*1000;
        res.writeHead(303,{Location:'/admin?google=connected'});return res.end();
      }
      if(path.startsWith('/api/admin/')) {
        const s=admin(req);
        if(method!=='GET') {sameOrigin(req);if(req.headers['x-csrf-token']!==s.csrf)throw new AppError(403,'Please refresh the dashboard and try again.');}
        if(path==='/api/admin/status'&&method==='GET') {
          const conf=store.get('google'),auth=store.get('oauth');
          return json(res,{csrf:s.csrf,configured:!!conf,connected:!!auth?.refresh_token,ownerEmail:conf?.ownerEmail||'',driveEmail:auth?.email||'',pickerKey:conf?.pickerKey||'',clientId:conf?.clientId||''});
        }
        if(path==='/api/admin/logout'&&method==='POST') {db.prepare('DELETE FROM sessions WHERE id=?').run(s.id);res.setHeader('Set-Cookie','dod_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');return json(res,{ok:true});}
        if(path==='/api/admin/password'&&method==='POST') {
          const b=await jsonBody(req);if(!store.checkPassword(String(b.current||'')))throw new AppError(400,'The current password did not match.');
          if(typeof b.password!=='string'||b.password.length<16||b.password.length>200)throw new AppError(400,'Use a password with at least 16 characters.');
          store.setPassword(b.password);db.prepare('DELETE FROM sessions WHERE id<>?').run(s.id);return json(res,{ok:true});
        }
        if(path==='/api/admin/google'&&method==='POST') {
          const b=await jsonBody(req),old=store.get('google');
          if(!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(b.clientId||'')||!b.clientSecret||!/^\S+@\S+\.\S+$/.test(b.ownerEmail||''))throw new AppError(400,'Enter the Google client ID, client secret, and owner email.');
          if(store.get('oauth') && (old.clientId!==b.clientId||old.ownerEmail!==b.ownerEmail))throw new AppError(400,'Disconnect Google before changing the owner or client ID.');
          store.set('google',{clientId:clean(b.clientId,200),clientSecret:clean(b.clientSecret,300),ownerEmail:clean(b.ownerEmail,200),pickerKey:clean(b.pickerKey,200)});
          return json(res,{ok:true});
        }
        if(path==='/api/admin/connect'&&method==='POST') {
          const conf=store.get('google');if(!conf)throw new AppError(400,'Save your Google connection settings first.');
          const state=randomToken(),verifier=randomToken();store.set('oauthPending',{state,verifier,session:s.id,expires:Date.now()+600000});
          const p=new URLSearchParams({client_id:conf.clientId,redirect_uri:origin+'/oauth/callback',response_type:'code',scope:'openid email https://www.googleapis.com/auth/drive.file',access_type:'offline',prompt:'consent',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',login_hint:conf.ownerEmail});
          return json(res,{url:'https://accounts.google.com/o/oauth2/v2/auth?'+p});
        }
        if(path==='/api/admin/disconnect'&&method==='POST') {store.set('oauth',null);drive.access='';drive.expires=0;return json(res,{ok:true});}
        if(path==='/api/admin/picker-token'&&method==='GET')return json(res,{token:await drive.token()});
        if(path==='/api/admin/folders'&&method==='GET')return json(res,await drive.folders());
        if(path==='/api/admin/collections'&&method==='GET')return json(res,{collections:db.prepare('SELECT * FROM collections ORDER BY created DESC').all().map(c=>({...c,url:`${origin}/c/${c.token}`}))});
        if(path==='/api/admin/collections'&&method==='POST') {
          const b=await jsonBody(req),name=clean(b.name);
          if(!name)throw new AppError(400,'Give your collection a name.');
          const folder=b.folder ? await drive.folder(b.folder) : await drive.createFolder(name);
          if(db.prepare('SELECT id FROM collections WHERE folder=?').get(folder.id))throw new AppError(400,'This folder already has a collection. Manage its existing link below.');
          const id=randomToken(),token=randomToken();
          db.prepare('INSERT INTO collections VALUES (?,?,?,?,?,1,1,?,?)').run(id,token,name,clean(b.description,1000),folder.id,100*1024**3,Date.now());
          return json(res,{id,url:`${origin}/c/${token}`},201);
        }
        const m=path.match(/^\/api\/admin\/collections\/([\w-]+)$/);
        if(m&&method==='PATCH') {
          const c=db.prepare('SELECT * FROM collections WHERE id=?').get(m[1]);if(!c)throw new AppError(404,'Collection not found.');
          const b=await jsonBody(req);const token=b.rotate?randomToken():c.token;
          db.prepare('UPDATE collections SET active=?,uploads_open=?,token=? WHERE id=?').run(typeof b.active==='boolean'?Number(b.active):c.active,typeof b.uploadsOpen==='boolean'?Number(b.uploadsOpen):c.uploads_open,token,c.id);
          return json(res,{url:`${origin}/c/${token}`});
        }
        throw new AppError(404,'This action is unavailable.');
      }
      const match=path.match(/^\/api\/c\/([\w-]+)(.*)$/);
      if(match) {
        const c=collection(match[1]),route=match[2];limit('collection:'+c.id+':'+ip,1200);
        if(method!=='GET')sameOrigin(req);
        if(route===''&&method==='GET')return json(res,publicCollection(c));
        if(route==='/files'&&method==='GET')return json(res,await drive.list(c.folder,(url.searchParams.get('page')||'').slice(0,2000)));
        const fileRoute=route.match(/^\/files\/([A-Za-z0-9_-]+)\/(download|preview|thumbnail)$/);
        if(fileRoute&&method==='GET') {
          const f=await drive.file(c.folder,fileRoute[1]),action=fileRoute[2];
          let upstream;
          const controller=new AbortController();
          res.on('close',()=>controller.abort());
          if(action==='thumbnail') {
            const meta=await (await drive.request(`/drive/v3/files/${encodeURIComponent(f.id)}?fields=thumbnailLink`)).json();
            if(!meta.thumbnailLink)throw new AppError(404,'No preview is available for this file.');
            const u=new URL(meta.thumbnailLink);
            if(u.protocol!=='https:'||!(u.hostname.endsWith('.googleusercontent.com')||u.hostname.endsWith('.google.com')))throw new AppError(502,'Preview unavailable.');
            upstream=await fetch(u,{headers:{Authorization:`Bearer ${await drive.token()}`},signal:AbortSignal.timeout(20000),redirect:'error'});
            if(!upstream.ok)throw new AppError(404,'Preview unavailable.');
          } else {
            const headers:Record<string,string>={};
            const range=req.headers.range;if(range&&/^bytes=\d*-\d*$/.test(range))headers.Range=range;
            upstream=await drive.request(`/drive/v3/files/${encodeURIComponent(f.id)}?alt=media`,{headers,signal:controller.signal});
          }
          res.statusCode=upstream.status;
          const mime=upstream.headers.get('content-type')||f.mimeType;
          res.setHeader('Content-Type',action==='thumbnail'&&mime.startsWith('image/')?mime:f.mimeType);
          for(const key of ['content-length','content-range','accept-ranges'])if(upstream.headers.has(key))res.setHeader(key,upstream.headers.get(key));
          res.setHeader('Content-Disposition',`${action==='download'?'attachment':'inline'}; filename*=UTF-8''${encodeURIComponent(f.name).replace(/'/g,'%27')}`);
          if(upstream.body)await pipeline(Readable.fromWeb(upstream.body),res);else res.end();return;
        }
        if(route==='/uploads'&&method==='POST') {
          canUpload(c);limit('starts:'+c.id+':'+ip,100);
          const b=await jsonBody(req),name=clean(b.name,240),mime=normalizeMime(name,b.mime);
          if(!name||!mime||!Number.isSafeInteger(b.size)||b.size<1||b.size>MAX_FILE)throw new AppError(400,'Choose a photo or video up to 10 GB.');
          // Persist the reservation before awaiting Google to prevent concurrent quota bypass.
          db.prepare("UPDATE uploads SET state='expired',session=NULL WHERE state<>'done' AND created<?").run(Date.now()-8*86400000);
          const reserved=db.prepare("SELECT coalesce(sum(size),0) AS n FROM uploads WHERE collection_id=? AND state<>'expired'").get(c.id).n;
          if(Number(reserved)+b.size>c.quota)throw new AppError(403,'This collection has reached its upload allowance. Please contact its owner.');
          const id=randomToken();
          db.prepare("INSERT INTO uploads(id,collection_id,file_id,name,mime,size,state,created) VALUES (?,?,?,?,?,?,'starting',?)").run(id,c.id,'pending',name,mime,b.size,Date.now());
          try {
            const file_id=await drive.newId();db.prepare('UPDATE uploads SET file_id=? WHERE id=?').run(file_id,id);
            const u=db.prepare('SELECT * FROM uploads WHERE id=?').get(id);locks.add(id);
            return json(res,await reconcile(u,c),201);
          } catch(e) {db.prepare("UPDATE uploads SET state='expired' WHERE id=?").run(id);throw e;} finally {locks.delete(id);}
        }
        const uploadRoute=route.match(/^\/uploads\/([\w-]+)$/);
        if(uploadRoute&&(method==='GET'||method==='PUT')) {
          const u=db.prepare('SELECT * FROM uploads WHERE id=? AND collection_id=?').get(uploadRoute[1],c.id);
          if(!u)throw new AppError(404,'Upload not found.');
          if(locks.has(u.id))throw new AppError(409,'This file is already uploading. Please wait and retry.');
          if(locks.size>=4)throw new AppError(429,'Several files are uploading right now. Please retry shortly.');
          locks.add(u.id);
          try {
            if(u.state==='expired')throw new AppError(410,'This upload expired. Choose Retry to start again.');
            if(method==='GET')return json(res,await reconcile(u,c));
            canUpload(c);
            if(u.state==='done')return json(res,{id:u.id,offset:u.size,done:true});
            if(!u.session)throw new AppError(409,'The upload is still starting. Please retry.');
            const offset=Number(req.headers['x-upload-offset']);
            if(!Number.isSafeInteger(offset)||offset!==u.offset)throw new AppError(409,'Upload progress has changed. Check its status and retry.');
            const chunk=await body(req,CHUNK);
            if(!chunk.length||offset+chunk.length>u.size||(offset+chunk.length<u.size&&chunk.length%262144!==0))throw new AppError(400,'Invalid upload chunk.');
            const result=await drive.session(store.open(u.session),u.size,offset,chunk);await confirm(u,c,result);
            return json(res,{id:u.id,offset:result.offset,done:result.done});
          } finally {locks.delete(u.id);}
        }
        throw new AppError(404,'This action is unavailable.');
      }
      if(method==='GET') {
        const assets={'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css'],'/favicon.svg':['favicon.svg','image/svg+xml']};
        const asset=assets[path];
        if(asset){res.setHeader('Content-Type',asset[1]);return res.end(readFileSync(join(root,'../public',asset[0])));}
        if(path==='/'||path==='/admin'||/^\/c\/[\w-]+$/.test(path)){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(readFileSync(join(root,'../public/index.html')));}
      }
      throw new AppError(404,'Page not found.');
    } catch(e) {
      if(res.headersSent){res.destroy();return;}
      const status=e instanceof AppError?e.status:500;
      // Never log URLs, guest tokens, OAuth codes, file names, or credentials.
      if(status===500)console.error('Request failed:',e.name);
      json(res,{error:e instanceof AppError?e.message:'Something went wrong. Please retry shortly.'},status);
    }
  });
  server.requestTimeout=120000;server.headersTimeout=15000;
  return {server,store,drive};
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const app=createApp();app.server.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('DOD is listening.'));
  const stop=()=>app.server.close(()=>{app.store.db.close();process.exit(0);});process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
