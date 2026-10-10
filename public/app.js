const app = document.querySelector('#app');
let csrf = '', ownerStatus, busy = false, collectionInfo;
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const size = n => {n=Number(n);const units=['B','KB','MB','GB'];let i=0;while(n>=1024&&i<3){n/=1024;i++;}return `${n.toFixed(i?1:0)} ${units[i]}`;};
const toast = message => {const el=document.querySelector('#toast');el.textContent=message;el.style.display='block';clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.style.display='none',4000);};
async function api(path, options={}) {
  const headers={...options.headers};
  if(options.body && !(options.body instanceof Blob)) {headers['Content-Type']='application/json';options.body=JSON.stringify(options.body);}
  if(csrf)headers['X-CSRF-Token']=csrf;
  const r=await fetch(path,{...options,headers});
  const data=await r.json().catch(()=>({error:'Could not reach the service. Please try again.'}));
  if(!r.ok){const e=new Error(data.error||'Request failed.');e.status=r.status;throw e;}return data;
}
const adminApi=(path,options)=>api('/api/admin/'+path,options);
function showError(form,message){let el=form.querySelector('.error');if(!el){el=document.createElement('p');el.className='error';el.setAttribute('role','alert');form.append(el);}el.textContent=message;}
async function submit(form, action) {const button=form.querySelector('button[type="submit"]');if(button)button.disabled=true;form.querySelector('.error')?.remove();try{await action(new FormData(form));}catch(e){showError(form,e.message);}finally{if(button)button.disabled=false;}}

function home() {
  app.innerHTML=`<section class="hero"><div><p class="eyebrow">A shared place for your trip</p><h1>Some moments<br>are better<br><em>together.</em></h1><p class="lead">Bring everyone’s photos and videos into one collection. One link to add your memories, enjoy the rest, and take them home.</p><a class="btn" href="/admin">Create a collection <span aria-hidden="true">↗</span></a><p class="hero-note">Guests need a link. That’s all.</p></div><div class="memory-art" aria-hidden="true"><span class="spark">✳</span><div class="postcard"><div class="landscape"></div><div class="postcard-caption">Wish you were here.</div></div><div class="mini-card"><div class="round-icon">↗</div><strong>Everyone’s perspective.</strong><p>All the good moments,<br>in the same place.</p></div></div></section><section class="features"><div><span>01 / GATHER</span><h3>Everyone can add a little.</h3><p>Photos and videos from every camera, without another account to create.</p></div><div><span>02 / ENJOY</span><h3>See the whole story.</h3><p>Browse the shared collection and download the moments you want to keep.</p></div><div><span>03 / KEEP</span><h3>Your memories. Your Drive.</h3><p>Original files stay in the owner’s Google Drive. Guests can add and download, but never delete.</p></div></section>`;
}
function login() {
  app.innerHTML=`<section class="panel narrow"><p class="eyebrow">Your space</p><h1>Welcome back.</h1><p class="muted">Sign in to create and manage your shared collections.</p><form id="login"><label class="field">Owner password<input name="password" type="password" autocomplete="current-password" required autofocus></label><button class="btn section-gap" type="submit">Open my collections ↗</button></form><p class="help section-gap">Visiting a collection? Open the shared link you were sent. You don’t need to sign in.</p></section>`;
  document.querySelector('#login').onsubmit=e=>{e.preventDefault();submit(e.target,async f=>{await api('/api/login',{method:'POST',body:{password:f.get('password')}});await dashboard();});};
}
async function dashboard() {
  try{ownerStatus=await adminApi('status');csrf=ownerStatus.csrf;}catch(e){if(e.status===401)return login();throw e;}
  const connected=ownerStatus.connected;
  app.innerHTML=`<div class="page-title row space-between"><div><p class="eyebrow">Your space</p><h1>Good things, gathered.</h1><p class="muted">Create a collection. Share its link. Let the memories come together.</p></div><button class="text-button" id="logout">Sign out</button></div>
    <div class="dashboard-grid"><section class="panel"><div class="row space-between"><h2>Your Google Drive</h2><span class="status-chip ${connected?'':'pending'}">${connected?'Connected':'Setup needed'}</span></div><p class="muted">${connected?`Files are saved in <strong>${escape(ownerStatus.driveEmail)}</strong>.`:'Connect your account once. Your guests won’t need Google accounts.'}</p>${connected?'<button class="btn secondary" id="disconnect">Disconnect Drive</button>':`<button class="btn" id="connect" ${ownerStatus.configured?'':'disabled'}>Connect Google Drive ↗</button>`}
    <details class="section-gap" ${ownerStatus.configured?'':'open'}><summary>Google connection settings</summary><p class="help">One-time setup in your own Google Cloud project. These credentials are stored encrypted on the server.</p><ol class="setup-steps"><li>Open <a href="https://console.cloud.google.com/apis/dashboard" target="_blank" rel="noopener noreferrer">Google Cloud Console ↗</a>. Create a project and enable the Google Drive API.</li><li>In Google Auth Platform, configure the app audience. If using Testing, add your owner email as a test user. Google testing connections can expire after seven days; use the appropriate production configuration before sharing long-term.</li><li>Create an OAuth client of type <strong>Web application</strong>. Authorized redirect URI:<br><code>${escape(location.origin)}/oauth/callback</code></li><li>Enter the client credentials below, then connect your Google account.</li><li>Optional: enable Google Picker API and create a browser API key restricted to this website and Picker API to select existing folders. New folders work without it.</li></ol>
    <form id="google-settings"><label class="field">Google account email<input name="ownerEmail" type="email" value="${escape(ownerStatus.ownerEmail)}" autocomplete="email" required></label><label class="field">OAuth client ID<input name="clientId" value="${escape(ownerStatus.clientId)}" required></label><label class="field">OAuth client secret<input name="clientSecret" type="password" autocomplete="off" required></label><label class="field">Google Picker API key <span class="muted">(optional)</span><input name="pickerKey" value="${escape(ownerStatus.pickerKey)}" autocomplete="off"></label><button class="btn secondary section-gap" type="submit">Save connection settings</button></form></details></section>
    <section class="panel"><p class="eyebrow">Start something shared</p><h2>A new collection</h2><form id="create-collection"><label class="field">Collection name<input name="name" placeholder="A week in Italy" maxlength="120" required ${connected?'':'disabled'}></label><label class="field">A welcome message <span class="muted">(optional)</span><textarea name="description" placeholder="All our favourite moments from the trip. Add yours and download the ones you love." maxlength="1000" ${connected?'':'disabled'}></textarea></label><label class="field">Where to save your files<select name="folder" id="folders" ${connected?'':'disabled'}><option value="">Create a new Google Drive folder</option></select></label>${connected&&ownerStatus.pickerKey?'<button class="text-button" id="pick-folder" type="button">Choose another folder from Drive ↗</button>':''}<p class="help">Everyone with the link can view and download the photos and videos you upload through DOD. Choose a new or empty folder intended for sharing.</p><button class="btn section-gap" type="submit" ${connected?'':'disabled'}>Create collection ↗</button>${connected?'':'<p class="help">Connect Google Drive first to create a real collection.</p>'}</form></section></div>
    <section class="section-gap"><div class="row space-between"><h2>Your collections</h2><span class="help">One link. Upload + download. No guest deletion.</span></div><div id="collections"><div class="loading">Loading your collections…</div></div></section>
    <details class="panel section-gap"><summary>Change owner password</summary><form id="password"><label class="field">Current password<input name="current" type="password" autocomplete="current-password" required></label><label class="field">New password<input name="password" type="password" autocomplete="new-password" minlength="16" required></label><button class="btn secondary section-gap" type="submit">Save new password</button></form></details>`;
  document.querySelector('#logout').onclick=async()=>{await adminApi('logout',{method:'POST',body:{}});csrf='';login();};
  document.querySelector('#google-settings').onsubmit=e=>{e.preventDefault();submit(e.target,async f=>{await adminApi('google',{method:'POST',body:Object.fromEntries(f)});toast('Google settings saved.');await dashboard();});};
  document.querySelector('#connect')?.addEventListener('click',async e=>{e.target.disabled=true;try{const r=await adminApi('connect',{method:'POST',body:{}});location.assign(r.url);}catch(err){toast(err.message);e.target.disabled=false;}});
  document.querySelector('#disconnect')?.addEventListener('click',async()=>{if(!confirm('Disconnect Drive? Shared collections will stop working until you reconnect the same Google account.'))return;await adminApi('disconnect',{method:'POST',body:{}});await dashboard();});
  document.querySelector('#password').onsubmit=e=>{e.preventDefault();submit(e.target,async f=>{await adminApi('password',{method:'POST',body:Object.fromEntries(f)});e.target.reset();toast('Your password has been changed.');});};
  document.querySelector('#create-collection').onsubmit=e=>{e.preventDefault();submit(e.target,async f=>{const r=await adminApi('collections',{method:'POST',body:Object.fromEntries(f)});e.target.reset();toast('Collection created. Your shared link is ready.');await loadCollections();});};
  document.querySelector('#pick-folder')?.addEventListener('click',pickFolder);
  if(connected){adminApi('folders').then(r=>{for(const f of r.files){const o=new Option(f.name,f.id);document.querySelector('#folders')?.append(o);}}).catch(e=>toast(e.message));}
  await loadCollections();
  if(new URLSearchParams(location.search).get('google')==='connected'){toast('Google Drive connected.');history.replaceState(null,'','/admin');}
}
async function pickFolder() {
  try {
    if(!window.gapi)await new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='https://apis.google.com/js/api.js';s.onload=resolve;s.onerror=()=>reject(new Error('Could not load Google’s folder chooser.'));document.head.append(s);});
    await new Promise(resolve=>gapi.load('picker',resolve));
    const {token}=await adminApi('picker-token');
    const view=new google.picker.DocsView(google.picker.ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true);
    new google.picker.PickerBuilder().addView(view).setOAuthToken(token).setDeveloperKey(ownerStatus.pickerKey).setAppId(ownerStatus.clientId.split('-')[0]).setOrigin(location.origin).setCallback(data=>{if(data.action===google.picker.Action.PICKED){const doc=data.docs[0],select=document.querySelector('#folders');select.append(new Option(doc.name,doc.id,true,true));}}).build().setVisible(true);
  } catch(e){toast(e.message);}
}
async function loadCollections() {
  const target=document.querySelector('#collections');
  try {
    const {collections}=await adminApi('collections');
    if(!collections.length){target.innerHTML='<div class="empty"><div class="round-icon">＋</div><h3>Your first collection starts here.</h3><p>Connect Drive, give it a name, and share a little space with your people.</p></div>';return;}
    target.innerHTML=collections.map(c=>`<article class="panel collection-card"><div><h3>${escape(c.name)}</h3><p class="help">${escape(c.description||'A shared place for photos and videos.')}</p><div class="link-box"><input value="${escape(c.url)}" readonly aria-label="Shared collection link"><button class="btn secondary copy" data-url="${escape(c.url)}">Copy link</button></div><div class="collection-actions"><a class="btn secondary" href="${escape(c.url)}" target="_blank" rel="noopener">Open collection ↗</a><button class="btn secondary update" data-id="${c.id}" data-action="uploads" data-value="${!c.uploads_open}">${c.uploads_open?'Close uploads':'Reopen uploads'}</button><button class="btn secondary update" data-id="${c.id}" data-action="rotate">Replace link</button><button class="btn ${c.active?'danger':'secondary'} update" data-id="${c.id}" data-action="active" data-value="${!c.active}">${c.active?'Disable link':'Enable link'}</button></div></div><span class="status-chip ${c.active?'':'pending'}">${!c.active?'Link disabled':c.uploads_open?'Sharing + uploads':'Downloads only'}</span></article>`).join('');
    target.querySelectorAll('.copy').forEach(b=>b.onclick=async()=>{try{await navigator.clipboard.writeText(b.dataset.url);toast('Link copied. Ready to share.');}catch{b.previousElementSibling.select();toast('Select and copy the link above.');}});
    target.querySelectorAll('.update').forEach(b=>b.onclick=async()=>{if(b.dataset.action==='rotate'&&!confirm('Replace the shared link? The old link will stop working immediately.'))return;b.disabled=true;try{const body=b.dataset.action==='rotate'?{rotate:true}:b.dataset.action==='uploads'?{uploadsOpen:b.dataset.value==='true'}:{active:b.dataset.value==='true'};await adminApi('collections/'+b.dataset.id,{method:'PATCH',body});await loadCollections();toast('Collection updated.');}catch(e){toast(e.message);b.disabled=false;}});
  }catch(e){target.innerHTML=`<p class="error" role="alert">${escape(e.message)}</p>`;}
}

const token=location.pathname.match(/^\/c\/([\w-]+)$/)?.[1];
const collectionApi=(path,options)=>api(`/api/c/${token}${path}`,options);
const queue=[];let running=false,hasMore='';
async function collection() {
  try{collectionInfo=await collectionApi('');}catch(e){app.innerHTML=`<div class="panel narrow"><p class="eyebrow">Shared collection</p><h1>Link unavailable.</h1><p class="muted">${escape(e.message)}</p><p class="help">Ask the collection owner for a new link.</p></div>`;return;}
  document.title=collectionInfo.name+' — DOD';
  app.innerHTML=`<section class="collection-heading"><p class="eyebrow">A shared collection</p><h1>${escape(collectionInfo.name)}</h1><p>${escape(collectionInfo.description||'All our favourite moments, in one place. Add yours and take home the ones you love.')}</p></section><section class="upload-box" id="dropzone"><div><h2>${collectionInfo.uploadsOpen?'Add your side of the story.':'The collection is all here.'}</h2><p>${collectionInfo.uploadsOpen?'Choose your photos and videos. Originals stay original.':'Uploads are closed, but you can still enjoy and download the memories.'}</p></div>${collectionInfo.uploadsOpen?'<button class="btn light" id="choose-files">＋ Choose photos & videos</button><input class="file-input" type="file" id="files" multiple accept="image/*,video/*,.heic,.heif,.mov,.mkv,.m4v" aria-label="Choose photos and videos">':''}</section><p class="upload-note">Anyone with this link can view, download${collectionInfo.uploadsOpen?', and add files':''}. Existing files can’t be deleted or replaced here.</p><section id="queue" class="queue off" aria-live="polite"><h3>Your uploads</h3><p class="help">Keep this page open and your phone awake until every file says “Saved in Drive”.</p><div id="queue-items"></div></section><div class="gallery-bar"><h2>Everyone’s memories</h2><button class="text-button" id="refresh">Refresh collection ↻</button></div><div id="gallery" class="gallery"></div><div id="gallery-message"></div><button class="btn secondary section-gap off" id="more">Load more memories</button>`;
  document.querySelector('#refresh').onclick=()=>loadGallery();document.querySelector('#more').onclick=()=>loadGallery(hasMore);
  document.querySelector('#choose-files')?.addEventListener('click',()=>document.querySelector('#files').click());
  document.querySelector('#files')?.addEventListener('change',e=>{addFiles([...e.target.files]);e.target.value='';});
  const dz=document.querySelector('#dropzone');
  if(collectionInfo.uploadsOpen){dz.ondragover=e=>{e.preventDefault();dz.classList.add('dragover');};dz.ondragleave=()=>dz.classList.remove('dragover');dz.ondrop=e=>{e.preventDefault();dz.classList.remove('dragover');addFiles([...e.dataTransfer.files]);};}
  await loadGallery();
}
async function loadGallery(page='') {
  const g=document.querySelector('#gallery'),msg=document.querySelector('#gallery-message'),more=document.querySelector('#more');
  msg.innerHTML='<div class="loading">Gathering the memories…</div>';more.disabled=true;
  try{
    const r=await collectionApi('/files'+(page?'?page='+encodeURIComponent(page):''));
    if(!page)g.replaceChildren();msg.replaceChildren();
    for(const f of r.files){
      const base=`/api/c/${token}/files/${encodeURIComponent(f.id)}`;
      const card=document.createElement('article');card.className='file-card';
      card.innerHTML=`<button class="thumb" aria-label="Preview ${escape(f.name)}">${f.hasThumbnail?`<img src="${base}/thumbnail" alt="" loading="lazy">`:`<span aria-hidden="true">${f.mimeType.startsWith('video/')?'▷':'▧'}</span>`}</button><div class="file-info"><p class="file-name" title="${escape(f.name)}">${escape(f.name)}</p><div class="file-meta">${f.mimeType.startsWith('video/')?'Video':'Photo'} · ${size(f.size||0)}</div><a class="download-link" href="${base}/download">Download original ↓</a></div>`;
      card.querySelector('img')?.addEventListener('error',e=>{e.target.replaceWith(document.createTextNode(f.mimeType.startsWith('video/')?'▷':'▧'));});
      card.querySelector('.thumb').onclick=()=>preview(f,base);g.append(card);
    }
    if(!g.children.length)msg.innerHTML='<div class="empty"><div class="round-icon">▧</div><h3>Every trip starts with a first photo.</h3><p>Add some memories to get this collection going. They’ll appear here once saved in Drive.</p></div>';
    hasMore=r.nextPageToken||'';more.classList.toggle('off',!hasMore);
  }catch(e){msg.innerHTML=`<div class="empty"><h3>Couldn’t load the collection.</h3><p>${escape(e.message)}</p></div>`;}finally{more.disabled=false;}
}
function preview(file,base) {
  const el=document.querySelector('#viewer-content');el.replaceChildren();
  const media=document.createElement(file.mimeType.startsWith('video/')?'video':'img');
  if(media.tagName==='VIDEO'){media.controls=true;media.preload='metadata';}else{media.alt=file.name;}
  media.src=base+'/preview';media.onerror=()=>{media.remove();const p=document.createElement('p');p.textContent='Your browser can’t preview this format. Download the original to view it.';el.prepend(p);};
  el.append(media);const p=document.createElement('p');p.textContent=file.name;el.append(p);
  const a=document.createElement('a');a.className='download-link';a.href=base+'/download';a.textContent='Download original ↓';el.append(a);document.querySelector('#viewer').showModal();
}
document.querySelector('#close-viewer').onclick=()=>document.querySelector('#viewer').close();
document.querySelector('#viewer').addEventListener('close',()=>document.querySelector('#viewer-content').replaceChildren());
function fingerprint(file){return [file.name,file.size,file.lastModified].join(':');}
function addFiles(files) {
  for(const file of files){if(queue.some(x=>fingerprint(x.file)===fingerprint(file)&&x.state!=='failed'))continue;queue.push({file,state:'waiting',offset:0,id:null,error:''});}
  renderQueue();runQueue();
}
function renderQueue(){
  document.querySelector('#queue').classList.remove('off');
  document.querySelector('#queue-items').innerHTML=queue.map((u,i)=>`<div class="upload-item"><div class="row"><span class="name" title="${escape(u.file.name)}">${escape(u.file.name)}</span><span class="state">${u.state==='done'?'✓ Saved in Drive':u.state==='failed'?'Needs attention':u.state==='waiting'?'Waiting':u.state==='retrying'?'Connection interrupted — retrying':`${Math.floor(u.offset/u.file.size*100)}% · ${size(u.offset)} / ${size(u.file.size)}`}</span></div><progress value="${u.offset}" max="${u.file.size}" aria-label="Upload progress for ${escape(u.file.name)}"></progress>${u.error?`<p class="error">${escape(u.error)}</p>`:''}${u.state==='failed'?`<button class="text-button retry" data-i="${i}">Retry this file</button>`:''}</div>`).join('');
  document.querySelectorAll('.retry').forEach(b=>b.onclick=()=>{const u=queue[Number(b.dataset.i)];u.state='waiting';u.error='';renderQueue();runQueue();});
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function upload(u) {
  const key='dod:'+token+':'+fingerprint(u.file);
  try {
    u.state='uploading';renderQueue();
    let previous;try{previous=JSON.parse(localStorage.getItem(key)||'null');}catch{}
    if(!u.id && previous?.id)u.id=previous.id;
    if(u.id){try{const s=await collectionApi('/uploads/'+u.id);u.offset=s.offset;if(s.done){u.state='done';localStorage.removeItem(key);return;}}catch(e){if(e.status===404||e.status===410){u.id=null;u.offset=0;}else throw e;}}
    if(!u.id){const s=await collectionApi('/uploads',{method:'POST',body:{name:u.file.name,size:u.file.size,mime:u.file.type}});u.id=s.id;u.offset=s.offset;try{localStorage.setItem(key,JSON.stringify({id:u.id}));}catch{}}
    let attempts=0;
    while(u.offset<u.file.size) {
      if(!navigator.onLine){u.state='retrying';renderQueue();await new Promise(resolve=>window.addEventListener('online',resolve,{once:true}));}
      try {
        const s=await collectionApi('/uploads/'+u.id,{method:'PUT',body:u.file.slice(u.offset,u.offset+collectionInfo.chunkSize),headers:{'Content-Type':'application/octet-stream','X-Upload-Offset':String(u.offset)}});
        if(s.offset===u.offset&&!s.done)throw new Error('No upload progress was confirmed.');
        u.offset=s.offset;u.state='uploading';attempts=0;renderQueue();
        if(s.done)break;
      } catch(e) {
        if(e.status&&![409,429,500,502,503,504].includes(e.status))throw e;
        if(++attempts>5)throw new Error('The connection is still interrupted. Choose Retry when you’re ready.');
        u.state='retrying';renderQueue();await sleep(Math.min(30000,2000*2**attempts));
        const s=await collectionApi('/uploads/'+u.id);u.offset=s.offset;if(s.done)break;
      }
    }
    const final=await collectionApi('/uploads/'+u.id);
    if(!final.done)throw new Error('Still waiting for Google Drive to confirm this file. Please retry.');
    u.offset=u.file.size;u.state='done';try{localStorage.removeItem(key);}catch{}
  }catch(e){u.state='failed';u.error=e.message;if(e.status===410){u.id=null;u.offset=0;try{localStorage.removeItem(key);}catch{}}}finally{renderQueue();}
}
async function runQueue(){
  if(running)return;running=true;busy=true;
  let wakeLock;
  try{wakeLock=await navigator.wakeLock?.request('screen');}catch{}
  try{while(queue.some(u=>u.state==='waiting')){const batch=queue.filter(u=>u.state==='waiting').slice(0,2);await Promise.all(batch.map(upload));}await loadGallery();if(queue.length&&queue.every(u=>u.state==='done'))toast('All your files are saved in Google Drive. Thank you!');}
  finally{running=false;busy=false;await wakeLock?.release().catch(()=>{});}
}
window.addEventListener('beforeunload',e=>{if(busy){e.preventDefault();e.returnValue='';}});
(async()=>{try{if(token)await collection();else if(location.pathname==='/admin')await dashboard();else home();}catch(e){app.innerHTML=`<div class="panel narrow"><h2>Something needs attention.</h2><p class="error">${escape(e.message)}</p><a href="${escape(location.pathname)}" class="btn secondary">Try again</a></div>`;}})();
