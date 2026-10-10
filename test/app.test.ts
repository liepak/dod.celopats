import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.ts';
import { AppError, Drive } from '../src/drive.ts';

class FakeDrive {
  files = new Map(); sessions = new Map(); calls = []; next = 0;
  access='';expires=0;
  async token(){return 'owner-only-google-token';}
  async folders(){return {files:[]};}
  async createFolder(name){const id='folder_'+ ++this.next;const f={id,name,mimeType:'application/vnd.google-apps.folder',capabilities:{canAddChildren:true}};this.files.set(id,f);return f;}
  async folder(id){return this.metadata(id);}
  async metadata(id){const f=this.files.get(id);if(!f)throw new AppError(404,'Not found.');return f;}
  async newId(){return 'file_'+ ++this.next;}
  async begin(folder,u){const id='session_'+u.file_id;this.sessions.set(id,{folder,...u,offset:0});this.calls.push({method:'POST',id:u.file_id});return id;}
  async session(id,size,offset,body){const s=this.sessions.get(id);if(!s)throw new AppError(410,'Expired.');if(body){assert.equal(offset,s.offset);s.offset+=body.length;}if(s.offset===size){const f={id:s.file_id,name:s.name,size:String(size),mimeType:s.mime,parents:[s.folder]};this.files.set(f.id,f);return {done:true,offset:size,file:f};}return {done:false,offset:s.offset};}
  async list(folder){return {files:[...this.files.values()].filter(f=>f.parents?.includes(folder))};}
  async file(folder,id){const f=await this.metadata(id);if(!f.parents?.includes(folder))throw new AppError(404,'Not in collection.');return f;}
  async request(path,opts={}){this.calls.push({path,method:opts.method||'GET'});return new Response('original bytes',{status:200,headers:{'Content-Type':'image/jpeg'}});}
}
test('collection permissions, resumable uploads, link controls and encrypted persistence',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'dod-test-')),drive=new FakeDrive();
  let app=createApp({dir,origin:'http://localhost',driveFactory:()=>drive});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  let base=`http://127.0.0.1:${app.server.address().port}`;
  let cookie='',csrf='';
  async function request(path,method='GET',body,extra={}) {
    const headers={Origin:'http://localhost'};if(cookie)headers.Cookie=cookie;if(csrf)headers['X-CSRF-Token']=csrf;
    if(body!==undefined)headers['Content-Type']=Buffer.isBuffer(body)?'application/octet-stream':'application/json';
    const r=await fetch(base+path,{method,headers:{...headers,...extra},body:body===undefined?undefined:Buffer.isBuffer(body)?body:JSON.stringify(body)});
    const text=await r.text();let data;try{data=JSON.parse(text);}catch{data=text;}return {status:r.status,data,headers:r.headers};
  }
  try{
    const password=readFileSync(join(dir,'owner-access.txt'),'utf8').match(/Password: (.*)/)[1];
    assert.equal((await request('/api/admin/collections')).status,401);
    const login=await request('/api/login','POST',{password});assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];csrf=login.data.csrf;
    assert.match(login.headers.get('set-cookie'),/HttpOnly/);
    assert.equal((await request('/api/admin/collections','POST',{name:'Trip'}, {'X-CSRF-Token':'wrong'})).status,403);
    assert.equal((await request('/api/admin/collections','POST',{name:'Trip'}, {Origin:'https://evil.example'})).status,403);
    const create=await request('/api/admin/collections','POST',{name:'Italy',description:'Shared trip'});assert.equal(create.status,201);
    const cpath='/api'+new URL(create.data.url).pathname;
    const info=await request(cpath);assert.equal(info.status,200);assert.equal(info.data.name,'Italy');assert.equal(info.data.folder,undefined);assert.equal(info.data.token,undefined);
    assert.equal((await request(cpath+'/uploads','POST',{name:'bad.html',mime:'text/html',size:7})).status,400);
    assert.equal((await request(cpath+'/uploads','POST',{name:'huge.mov',mime:'video/quicktime',size:11*1024**3})).status,400);
    let up=await request(cpath+'/uploads','POST',{name:'same.jpg',mime:'image/jpeg',size:262150});assert.equal(up.status,201);
    const upath=cpath+'/uploads/'+up.data.id;
    assert.equal((await request(upath,'PUT',Buffer.alloc(1),{'X-Upload-Offset':'1'})).status,409);
    const first=await request(upath,'PUT',Buffer.alloc(262144),{'X-Upload-Offset':'0'});assert.equal(first.data.offset,262144);assert.equal(first.data.done,false);
    assert.equal((await request(upath)).data.offset,262144);
    const final=await request(upath,'PUT',Buffer.alloc(6),{'X-Upload-Offset':'262144'});assert.equal(final.data.done,true);
    assert.equal((await request(upath,'PUT',Buffer.alloc(6),{'X-Upload-Offset':'262144'})).data.done,true);
    const second=await request(cpath+'/uploads','POST',{name:'same.jpg',mime:'image/jpeg',size:7});
    await request(cpath+'/uploads/'+second.data.id,'PUT',Buffer.alloc(7),{'X-Upload-Offset':'0'});
    const listing=await request(cpath+'/files');assert.equal(listing.data.files.length,2);assert.notEqual(listing.data.files[0].id,listing.data.files[1].id);
    const fid=listing.data.files[0].id;
    assert.equal((await request(cpath+`/files/${fid}/download`)).data,'original bytes');
    assert.equal((await request(cpath+`/files/${fid}`,'DELETE')).status,404);
    assert.equal((await request(cpath+`/files/${fid}`,'PATCH',{name:'changed.jpg'})).status,404);
    drive.files.set('outsider',{id:'outsider',mimeType:'image/jpeg',size:'10',parents:['private-folder']});
    assert.equal((await request(cpath+'/files/outsider/download')).status,404);
    const another=await request('/api/admin/collections','POST',{name:'Other trip'});
    const otherPath='/api'+new URL(another.data.url).pathname;
    assert.equal((await request(otherPath+'/uploads/'+up.data.id)).status,404);
    const adminId=create.data.id;
    await request('/api/admin/collections/'+adminId,'PATCH',{uploadsOpen:false});
    assert.equal((await request(cpath+'/uploads','POST',{name:'new.jpg',mime:'image/jpeg',size:3})).status,403);
    assert.equal((await request(cpath+'/files')).status,200);
    const rotated=await request('/api/admin/collections/'+adminId,'PATCH',{rotate:true});
    assert.equal((await request(cpath)).status,404);
    const newPath='/api'+new URL(rotated.data.url).pathname;
    await request('/api/admin/collections/'+adminId,'PATCH',{active:false});assert.equal((await request(newPath)).status,404);
    app.store.set('secret-test',{refresh_token:'PRIVATE_REFRESH_TOKEN'});
    assert.equal(readFileSync(join(dir,'dod.sqlite')).includes(Buffer.from('PRIVATE_REFRESH_TOKEN')),false);
    // A server restart retains owner login and encrypted credentials.
    await new Promise(resolve=>app.server.close(resolve));app.store.db.close();
    app=createApp({dir,origin:'http://localhost',driveFactory:()=>drive});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${app.server.address().port}`;
    assert.equal(app.store.get('secret-test').refresh_token,'PRIVATE_REFRESH_TOKEN');assert.equal((await request('/api/admin/collections')).data.collections.length,2);
    assert.ok(drive.calls.every(c=>c.method==='GET'||c.method==='POST'));
  }finally{await new Promise(resolve=>app.server.close(resolve));app.store.db.close();rmSync(dir,{recursive:true,force:true});}
});

test('Google upload protocol treats 308 as partial, 200 as complete, and 404 as expired',async()=>{
  const original=globalThis.fetch;
  const dir=mkdtempSync(join(tmpdir(),'dod-drive-'));
  const app=createApp({dir});const drive=new Drive(app.store);drive.access='fake';drive.expires=Date.now()+1000000;
  try{
    let calls=[];
    globalThis.fetch=async(url,opts)=>{calls.push({url,opts});return new Response(null,{status:308,headers:{range:'bytes=0-262143'}});};
    const partial=await drive.session('https://www.googleapis.com/upload/session',300000,0,Buffer.alloc(262144));
    assert.equal(partial.offset,262144);assert.equal(partial.done,false);assert.equal(calls[0].opts.headers['Content-Range'],'bytes 0-262143/300000');
    globalThis.fetch=async()=>new Response(JSON.stringify({id:'f'}),{status:200});
    assert.equal((await drive.session('https://www.googleapis.com/upload/session',300000)).done,true);
    globalThis.fetch=async()=>new Response(null,{status:404});
    await assert.rejects(()=>drive.session('https://www.googleapis.com/upload/session',300000),e=>e.status===410);
    await assert.rejects(()=>drive.session('https://evil.example/upload',300000),e=>e.status===500);
  }finally{globalThis.fetch=original;app.store.db.close();rmSync(dir,{recursive:true,force:true});}
});
