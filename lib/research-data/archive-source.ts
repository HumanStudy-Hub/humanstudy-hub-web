import { createHash } from 'node:crypto';
import type { StudioContext } from '../studio/auth';
import { studioFetch, studioConfig, upstreamJson, StudioError } from '../studio/http';
import { LIMITS, MANIFEST_FORMAT, scrubResearchString, validateResearchEvent, type ResearchContentRow, type ResearchEvent } from './contract';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const stableId = (s: string) => { const h = digest(Buffer.from(s)).slice(0,32).split(''); h[12]='4';h[16]='8';const x=h.join('');return `${x.slice(0,8)}-${x.slice(8,12)}-${x.slice(12,16)}-${x.slice(16,20)}-${x.slice(20)}`; };

/** Existing studio storage remains the durable retry source. No original text is rewritten. */
/**
 * `actionId`: the browser operation that imported the file (T10: action_id = caused_by = it, trigger
 * import). Without one (archived after a reload, or a source the project already had) the record is
 * labelled `trigger: baseline`, the state found when the project opened.
 */
export async function archiveSource(ctx: StudioContext, project: string, source: { id: string; name: string; mimeType: string; path: string; size: number }, actionId?: string) {
  const archived=await upstreamJson<Array<{source_id:string}>>(await studioFetch(`/rest/v1/research_events?owner_id=eq.${ctx.user.id}&project_id=eq.${project}&event_type=eq.source.import&metadata->>source_record_id=eq.${source.id}&select=source_id&limit=1`,{token:ctx.accessToken}));
  if(archived.length)return {sha256:archived[0].source_id,bytes:source.size};
  const response = await studioFetch(`/storage/v1/object/authenticated/studio-sources/${source.path}`, { token: ctx.accessToken });
  if (!response.ok) throw new StudioError(502, 'research_source_unavailable');
  const reader = response.body?.getReader(); if (!reader) throw new StudioError(502, 'research_source_unavailable');
  const buffers: Uint8Array[]=[]; let size=0;
  for (;;) { const {value,done}=await reader.read(); if(done)break; size+=value.length; if(size>source.size){await reader.cancel();throw new StudioError(502,'research_source_size_mismatch');}buffers.push(value); }
  if(size!==source.size)throw new StudioError(502,'research_source_size_mismatch');
  const bytes=Buffer.concat(buffers), hash=digest(bytes), parts:Array<{sha256:string;bytes:number}>=[];
  async function store(sha256: string, data: Uint8Array, row: ResearchContentRow) {
    const existing=await upstreamJson<Array<{sha256:string}>>(await studioFetch(`/rest/v1/research_content?owner_id=eq.${ctx.user.id}&sha256=eq.${sha256}&select=sha256&limit=1`,{token:ctx.accessToken}));
    if(existing.length)return;
    const {url,key}=studioConfig();
    const objectUrl=`${url}/storage/v1/object/research-content/${ctx.user.id}/${sha256}`;
    const r=await fetch(objectUrl,{method:'POST',headers:{apikey:key,Authorization:`Bearer ${ctx.accessToken}`,'Content-Type':'application/octet-stream','x-upsert':'false'},body:new Uint8Array(data),signal:AbortSignal.timeout(20000)});
    if(!r.ok){
      const error=await r.json().catch(()=>({}));
      if(!(r.status===409||error.statusCode==='409'||error.error==='Duplicate'))throw new StudioError(502,'research_source_upload_pending');
      const old=await fetch(`${url}/storage/v1/object/authenticated/research-content/${ctx.user.id}/${sha256}`,{headers:{apikey:key,Authorization:`Bearer ${ctx.accessToken}`},signal:AbortSignal.timeout(20000)});
      if(!old.ok||!Buffer.from(await old.arrayBuffer()).equals(Buffer.from(data)))throw new StudioError(502,'research_source_conflict');
    }
    await upstreamJson(await studioFetch('/rest/v1/research_content?on_conflict=owner_id,sha256',{method:'POST',token:ctx.accessToken,headers:{Prefer:'resolution=ignore-duplicates,return=representation'},body:row}));
  }
  for(let at=0;at<bytes.length;at+=LIMITS.partBytes){const part=bytes.subarray(at,Math.min(at+LIMITS.partBytes,bytes.length)),sha256=digest(part);parts.push({sha256,bytes:part.length});await store(sha256,part,{sha256,kind:'part',bytes:part.length,stored_bytes:part.length,mime:source.mimeType,encoding:'identity',surface:'web'});}
  if(parts.length>1){const manifest=Buffer.from(JSON.stringify({format:MANIFEST_FORMAT,encoding:'bytes',bytes:size,sha256:hash,mime:source.mimeType,parts}));await store(hash,manifest,{sha256:hash,kind:'manifest',bytes:size,stored_bytes:manifest.length,mime:source.mimeType,encoding:'identity',parts:parts.map(p=>p.sha256),surface:'web'});}
  const key=`${ctx.user.id}:${project}:${source.id}:${hash}`, session=stableId(`session:${key}`), now=new Date().toISOString();
  // PostgREST bulk insert requires identical top-level keys in every row, including nullable ones.
  const base={contract_version:'1.0.0',surface:'web',install_id:'web-source-archive',research_session_id:session,occurred_at:now,project_id:project,source_id:null,action_id:null,caused_by:null,app_version:'web',collector_version:'source-archive/1.0.0',consent_version:3,platform:'browser',content_refs:[]};
  const rows=[
    {...base,id:stableId(`start:${key}`),client_seq:1,data_type:'session',event_type:'session.start',metadata:{collection_mode:'source-import'}},
    {...base,id:stableId(`source:${key}`),client_seq:2,data_type:'source_input',event_type:'source.import',source_id:hash,...(actionId?{action_id:actionId,caused_by:actionId}:{}),metadata:{provenance:'web-upload',trigger:actionId?'import':'baseline',source_record_id:source.id,filename:scrubResearchString(source.name)},content_refs:[{role:'source',sha256:hash,bytes:size,mime:source.mimeType}]},
    {...base,id:stableId(`end:${key}`),client_seq:3,data_type:'session',event_type:'session.end',metadata:{captured_through_seq:3,reason:'source-archived'}},
  ] as ResearchEvent[];
  for(const row of rows)if(validateResearchEvent(row).length)throw new StudioError(500,'invalid_research_source_event');
  await upstreamJson(await studioFetch('/rest/v1/research_events?on_conflict=id',{method:'POST',token:ctx.accessToken,headers:{Prefer:'resolution=ignore-duplicates,return=representation'},body:rows}));
  return {sha256:hash,bytes:size};
}
