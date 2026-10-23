import type { StudioEvent } from '../studio/types';
import {ACTION_VIA,scrubResearchValue,validateResearchEvent,type ResearchEvent} from './contract';

/** Names older clients sent for chat/review primaries without an explicit target. */
const LEGACY_TARGET: Record<string,string> = { 'chat:send':'composer.send', 'chat:build':'build.start', 'review:apply':'proposal.apply', 'review:reject':'proposal.reject' };

/**
 * UI events only. The browser cannot submit authoritative assistant/tool output.
 * click/chat/review are the operation's single action.invoke (T10: named by the first product
 * action, `metadata.via` = input route); selection/layout are completion records linked to the
 * operation that made them (`actionId`); scroll/visibility are passive and never linked.
 */
export function webResearchEvent(e: StudioEvent, workspace: string): ResearchEvent {
  const {via:rawVia,parentActionId,...m}=e.metadata??{},type=e.type;
  const via=(ACTION_VIA as readonly string[]).includes(rawVia as string)?rawVia as string:'pointer';
  const target=e.target??LEGACY_TARGET[`${type}:${m.action}`]??String(m.action??type);
  const base:ResearchEvent={id:e.id,contract_version:'1.0.0',surface:'web',platform:'browser',
    install_id:e.research?.installId??'web-legacy-bridge',research_session_id:e.research?e.sessionId:e.id,
    client_seq:e.research?.seq??1,occurred_at:e.at,project_id:workspace,
    event_type:'action.invoke',data_type:'interaction',view:String(m.area??'workspace'),target,action_id:e.id,duration_ms:null,
    metadata:scrubResearchValue({...m,via,...(typeof parentActionId==='string'?{parent_action_id:parentActionId}:{}),legacy_bridge:!e.research,display_revision:e.displayRevision}) as Record<string,unknown>,content_refs:[],
    app_version:'web',collector_version:'web-collector/1.1.0',consent_version:3};
  const record={action_id:e.actionId??null,metadata:scrubResearchValue({...m,legacy_bridge:!e.research,display_revision:e.displayRevision}) as Record<string,unknown>};
  if(type==='scroll')Object.assign(base,{event_type:'scroll.settle',data_type:'navigation',action_id:null,metadata:{...record.metadata,position:m.endDepth??0,direction:m.direction??'unknown',distance:Math.abs(Number(m.endDepth??0)-Number(m.startDepth??0))}});
  if(type==='visibility')Object.assign(base,{event_type:'app.foreground',data_type:'navigation',action_id:null,metadata:record.metadata,duration_ms:e.durationMs??0});
  if(type==='selection')Object.assign(base,{event_type:'selection.commit',data_type:'selection_layout',...record,metadata:{...record.metadata,kind:m.mode??'selection'}});
  if(type==='layout')Object.assign(base,{event_type:'layout.commit',data_type:'selection_layout',...record,metadata:{...record.metadata,state:m}});
  const errors=validateResearchEvent(base);if(errors.length)throw new Error(errors.join('; '));
  return base;
}
