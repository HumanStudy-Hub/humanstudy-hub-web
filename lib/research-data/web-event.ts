import type { StudioEvent } from '../studio/types';
import {scrubResearchValue,validateResearchEvent,type ResearchEvent} from './contract';

/** UI events only. The browser cannot submit authoritative assistant/tool output. */
export function webResearchEvent(e: StudioEvent, workspace: string): ResearchEvent {
  const m=e.metadata??{},type=e.type;
  const base:ResearchEvent={id:e.id,contract_version:'1.0.0',surface:'web',platform:'browser',
    install_id:e.research?.installId??'web-legacy-bridge',research_session_id:e.research?e.sessionId:e.id,
    client_seq:e.research?.seq??1,occurred_at:e.at,project_id:workspace,
    event_type:'action.invoke',data_type:'interaction',view:String(m.area??'workspace'),target:e.target??String(m.action??type),action_id:e.id,duration_ms:null,
    metadata:scrubResearchValue({...m,via:'pointer',legacy_bridge:!e.research,display_revision:e.displayRevision}) as Record<string,unknown>,content_refs:[],
    app_version:'web',collector_version:'web-collector/1.0.0',consent_version:3};
  if(type==='scroll')Object.assign(base,{event_type:'scroll.settle',data_type:'navigation',action_id:null,metadata:{...base.metadata,position:m.endDepth??0,direction:m.direction??'unknown',distance:Math.abs(Number(m.endDepth??0)-Number(m.startDepth??0))}});
  if(type==='visibility')Object.assign(base,{event_type:'app.foreground',data_type:'navigation',action_id:null,duration_ms:e.durationMs??0});
  if(type==='selection')Object.assign(base,{event_type:'selection.commit',data_type:'selection_layout',action_id:null,metadata:{...base.metadata,kind:m.mode??'selection'}});
  if(type==='layout')Object.assign(base,{event_type:'layout.commit',data_type:'selection_layout',action_id:null,metadata:{...base.metadata,state:m}});
  const errors=validateResearchEvent(base);if(errors.length)throw new Error(errors.join('; '));
  return base;
}
