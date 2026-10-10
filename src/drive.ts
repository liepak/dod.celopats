import type { Store } from './store.ts';

export class AppError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export const isMedia = (mime: string) => /^(image\/(jpeg|png|webp|gif|heic|heif|avif|tiff|bmp)|video\/(mp4|quicktime|webm|x-matroska|mpeg|3gpp|x-msvideo|x-m4v))$/.test(mime);
export const normalizeMime = (name: string, mime: string) => {
  const ext = name.split('.').pop()?.toLowerCase();
  const map = {jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif',heic:'image/heic',heif:'image/heif',avif:'image/avif',tif:'image/tiff',tiff:'image/tiff',bmp:'image/bmp',mp4:'video/mp4',mov:'video/quicktime',webm:'video/webm',mkv:'video/x-matroska',mpeg:'video/mpeg',mpg:'video/mpeg',m4v:'video/x-m4v',avi:'video/x-msvideo', '3gp':'video/3gpp'};
  return isMedia(mime) ? mime : map[ext] || '';
};
export class Drive {
  store: Store;
  access = '';
  expires = 0;
  refreshing: Promise<string> | null = null;
  constructor(store: Store) { this.store = store; }
  async token(): Promise<string> {
    if (this.access && this.expires > Date.now() + 60000) return this.access;
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refresh();
    try { return await this.refreshing; } finally { this.refreshing = null; }
  }
  async refresh() {
    const conf = this.store.get('google'), auth = this.store.get('oauth');
    if (!conf || !auth?.refresh_token) throw new AppError(503, 'The owner needs to connect Google Drive.');
    const r = await fetch('https://oauth2.googleapis.com/token', { method:'POST', body:new URLSearchParams({client_id:conf.clientId,client_secret:conf.clientSecret,refresh_token:auth.refresh_token,grant_type:'refresh_token'}), signal:AbortSignal.timeout(20000) });
    if (!r.ok) throw new AppError(503, 'Google Drive needs reconnecting. Please let the collection owner know.');
    const data = await r.json(); this.access = data.access_token; this.expires = Date.now() + data.expires_in * 1000; return this.access;
  }
  async request(path: string, init: RequestInit = {}) {
    const token = await this.token();
    const headers = new Headers(init.headers); headers.set('Authorization', `Bearer ${token}`);
    // A header timeout must not abort a large video download after it starts.
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(),60000);
    let response;
    try { response = await fetch(`https://www.googleapis.com${path}`, {...init,headers,signal:init.signal || controller.signal}); }
    finally { clearTimeout(timer); }
    if (!response.ok) {
      const body = await response.json().catch(()=>({}));
      const reason = body.error?.errors?.[0]?.reason;
      if (reason === 'storageQuotaExceeded') throw new AppError(503, 'The collection owner’s Google Drive storage is full.');
      if (response.status === 404) throw new AppError(404, 'This file or folder is no longer available.');
      if (response.status === 429 || response.status >= 500) throw new AppError(503, 'Google Drive is busy. Please try again shortly.');
      throw new AppError(503, 'Google Drive could not complete this request. The owner may need to reconnect it.');
    }
    return response;
  }
  async metadata(id: string) { return (await this.request(`/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,mimeType,size,parents,trashed,capabilities(canAddChildren,canDownload)`)).json(); }
  async folder(id: string) {
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(id)) throw new AppError(400,'Choose a valid Google Drive folder.');
    const f = await this.metadata(id);
    if (f.trashed || f.mimeType !== 'application/vnd.google-apps.folder' || !f.capabilities?.canAddChildren) throw new AppError(400,'Choose a folder you can upload into.');
    return f;
  }
  async createFolder(name: string) { return (await this.request('/drive/v3/files?fields=id,name',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,mimeType:'application/vnd.google-apps.folder'})})).json(); }
  async folders() { return (await this.request('/drive/v3/files?' + new URLSearchParams({q:"trashed=false and mimeType='application/vnd.google-apps.folder'",fields:'files(id,name),nextPageToken',pageSize:'100',orderBy:'name'}))).json(); }
  async list(folder: string, page = '') {
    const q = `'${folder}' in parents and trashed=false and (mimeType contains 'image/' or mimeType contains 'video/')`;
    const p = new URLSearchParams({q,fields:'files(id,name,mimeType,size,createdTime,hasThumbnail),nextPageToken',pageSize:'100',orderBy:'createdTime desc'});
    if (page) p.set('pageToken',page);
    const data = await (await this.request('/drive/v3/files?' + p)).json();
    data.files = data.files.filter(f=>isMedia(f.mimeType)); return data;
  }
  async file(folder: string, id: string) {
    const f = await this.metadata(id);
    if (f.trashed || !f.parents?.includes(folder) || !isMedia(f.mimeType)) throw new AppError(404,'File not found in this collection.');
    return f;
  }
  async newId() { return (await (await this.request('/drive/v3/files/generateIds?count=1&space=drive&type=files')).json()).ids[0]; }
  async begin(folder: string, file: {file_id: string, name: string, mime: string, size: number}) {
    const r = await this.request('/upload/drive/v3/files?uploadType=resumable&fields=id,size,parents,mimeType', {method:'POST',headers:{'Content-Type':'application/json','X-Upload-Content-Type':file.mime,'X-Upload-Content-Length':String(file.size)},body:JSON.stringify({id:file.file_id,name:file.name,mimeType:file.mime,parents:[folder]})});
    const location = r.headers.get('location');
    if (!location || new URL(location).origin !== 'https://www.googleapis.com') throw new AppError(502,'Could not start an upload.');
    return location;
  }
  async session(url: string, size: number, offset?: number, body?: Buffer) {
    if (new URL(url).origin !== 'https://www.googleapis.com') throw new AppError(500,'Invalid upload session.');
    const headers = {'Authorization':`Bearer ${await this.token()}`,'Content-Range':body ? `bytes ${offset}-${offset + body.length - 1}/${size}` : `bytes */${size}`,'Content-Length':String(body?.length || 0)};
    const r = await fetch(url,{method:'PUT',headers,body:body || Buffer.alloc(0),signal:AbortSignal.timeout(60000),redirect:'error'});
    if (r.status === 308) {
      const range = r.headers.get('range'); return {offset:range ? Number(range.match(/\d+-(\d+)/)?.[1]) + 1 : 0, done:false};
    }
    if (r.status === 200 || r.status === 201) return {offset:size,done:true,file:await r.json()};
    if (r.status === 404 || r.status === 410) throw new AppError(410,'This upload expired. Choose Retry to start it again.');
    if (r.status === 403) {
      const e = await r.json().catch(()=>({}));
      if (e.error?.errors?.some(x=>x.reason==='storageQuotaExceeded')) throw new AppError(503,'The collection owner’s Google Drive storage is full.');
    }
    throw new AppError(503,'Upload interrupted. Please retry; confirmed progress is saved.');
  }
}
