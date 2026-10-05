import type { StudioDocument } from './types';

// A queued input/change effect may arrive while the async operation is in flight.
// Keep those edits, while accepting authoritative model/proposal/task updates.
export function mergeStudioUpdate(server:StudioDocument,late:StudioDocument|null):StudioDocument {
 if(!late)return server;
 const byId=new Map(late.conversations.map(c=>[c.id,c]));
 const conversations=server.conversations.map(c=>{
  const draft=byId.get(c.id);if(!draft)return c;byId.delete(c.id);
  const ids=new Set(c.messages.map(m=>m.id));
  const liveIds=new Set(server.model.entities.map(e=>e.id));
  return {...c,draft:draft.draft,selected:liveIds.has(draft.selected)?draft.selected:c.selected,modelAnchor:draft.modelAnchor?.entityIds.every(id=>liveIds.has(id))?draft.modelAnchor:c.modelAnchor,sourceSelection:draft.sourceSelection,messages:[...c.messages,...draft.messages.filter(m=>!ids.has(m.id))]};
 });
 return {...server,annotations:late.annotations,reviewResponses:late.reviewResponses,activeConversationId:late.activeConversationId||server.activeConversationId,conversations:[...conversations,...byId.values()]};
}
