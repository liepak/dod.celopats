export async function droppedFiles(transfer) {
  // Capture entries before the browser clears the drop event's data store.
  const entries=Array.from(transfer.items||[],item=>item.webkitGetAsEntry?.()).filter(Boolean);
  const fallback=Array.from(transfer.files||[]);
  if(!entries.length)return fallback;
  const files=[];
  async function visit(entry,path='') {
    if(entry.isFile){const file=await new Promise((resolve,reject)=>entry.file(resolve,reject));Object.defineProperty(file,'dodPath',{value:path+file.name,configurable:true});files.push(file);return;}
    if(!entry.isDirectory)return;
    const reader=entry.createReader();
    while(true){const batch=await new Promise((resolve,reject)=>reader.readEntries(resolve,reject));if(!batch.length)break;for(const child of batch)await visit(child,path+entry.name+'/');}
  }
  for(const entry of entries)await visit(entry);
  return files;
}
export function mediaFiles(files){return files.filter(file=>/^(image|video)\//.test(file.type)||/\.(jpe?g|png|webp|gif|heic|heif|avif|tiff?|bmp|mp4|mov|webm|mkv|mpe?g|m4v|avi|3gp)$/i.test(file.name));}
