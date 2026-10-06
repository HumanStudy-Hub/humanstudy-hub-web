import type { StudySchema } from "@/app/build-preview/study-schema";
import type { ModelAnchor, ReviewResponse } from "@/app/build-preview/model-review";

export type SourceSelection = { sourceId?: string; page: number; rects: { x:number; y:number; w:number; h:number }[]; text:string; kind:"text"|"region"|"evidence" };
export type StudioAnnotation = SourceSelection & { id:string; comment:string; entity:string; createdAt:string };
export type StudioArtifact = { id:string; title:string; filename:string; format:'markdown'|'csv'|'json'|'text'|'python'|'r'; kind:'instructions'|'instrument'|'analysis'|'other'; content:string; sourceIds:string[] };
export type StudioMessageRef = { conversationId:string; messageId:string };
export type StudioMessage = { id:string; role:"user"|"agent"; text:string; createdAt:string; entityId?:string; context?:string; modelAnchor?:ModelAnchor; sourceSelection?:SourceSelection; replyTo?:StudioMessageRef; mergedFrom?:StudioMessageRef; evidence?:StudySchema["entities"][number]["evidence"][]; proposal?:{ id:string; model:StudySchema; changesModel?:boolean; artifacts?:StudioArtifact[]; summary:string; status:"pending"|"applied"|"rejected"; baseModelFingerprint?:string; jobId?:string } };
export type StudioConversation = { id:string; title:string; updatedAt:string; messages:StudioMessage[]; parent?:StudioMessageRef; draft:string; modelAnchor:ModelAnchor|null; sourceSelection:SourceSelection|null; selected:string };
export type StudioSource = { id:string; name:string; path:string; mimeType:string; size:number; kind?:"paper"|"resource"; includeInBuild?:boolean; text?:string; pages?:{page:number; text:string}[] };
export type StudioPipeline = { jobId:string; requestId:string; conversationId:string; sourceId:string; status:"preparing"|"queued"|"running"|"review"|"complete"|"failed"; message:string; updatedAt:string; proposalId?:string; resultMessageId?:string; kind?:"initial"|"sync"; baseModelFingerprint?:string; targetModelFingerprint?:string };
export type StudioAcceptedPackage = { jobId:string; modelFingerprint:string; acceptedAt:string; approvalPending?:boolean };
// Retained for compatibility with existing saved metadata; no new version entries are created.
export type ProgramVersion = { id:string; parentId?:string; createdAt:string; label:string; fingerprint:string; proposalId?:string; model?:StudySchema };
export type StudioDocument = {
 programVersions?:ProgramVersion[];
 pipeline?:StudioPipeline;
 discussion?:StudioPipeline;
 acceptedPackage?:StudioAcceptedPackage;
 version:1; title:string; model:StudySchema; sources:StudioSource[];
 annotations:StudioAnnotation[]; conversations:StudioConversation[];
 artifacts?:StudioArtifact[];
 reviewResponses:Record<string,ReviewResponse>; activeConversationId?:string;
};
export type StudioWorkspace = { id:string; title:string; revision:number; document:StudioDocument; created_at:string; updated_at:string };
export type StudioUser = { id:string; email?:string };
export type StudioEvent = { id:string; sessionId:string; type:"click"|"pointer"|"scroll"|"selection"|"visibility"|"chat"|"review"|"layout"; at:string; target?:string; x?:number; y?:number; durationMs?:number; metadata?:Record<string,string|number|boolean> };
