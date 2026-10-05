"use client";

import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import Link from "next/link";
import StudioHome from "@/components/studio/home";
import Image from "next/image";
import { study as exampleStudy, type Entity, type Rect } from "./study-schema";
import StudyModel from "./study-model";
import { quoteRects } from "@/lib/studio/source-anchor";
import { modelOverview, modelIssues, type ModelAnchor, type ReviewResponse } from "./model-review";
import s from "./workspace.module.css";
import type { StudioDocument, StudioConversation, StudioMessage } from "@/lib/studio/types";
import { UiIcon, LanguageContext, translator, type Language } from "./ui";

export type Page = { page:number; width:number; height:number; image:string; words:{t:string;x:number;y:number;w:number;h:number}[] };
type Selection = { sourceId?:string; page:number; rects:Rect[]; text:string; kind:"text"|"region"|"evidence" };
type Note = Selection & { id:string; comment:string; entity:string; createdAt:string };
type Message = { proposal?:StudioMessage["proposal"]; id?:string; entityId?:string; createdAt?:string; role:"user"|"agent"; text:string; context?:string; modelAnchor?:ModelAnchor; sourceSelection?:Selection; evidence?:typeof exampleStudy.entities[number]["evidence"][] };
type Conversation = { id:string; title:string; updatedAt:string; messages:Message[]; draft:string; modelAnchor:ModelAnchor|null; sourceSelection:Selection|null; selected:string };
const chatKey="build-study-conversations-v5";
export type ConnectedStudio = {workspaceId:string;initialDocument:StudioDocument;pages:Page[];sourceId?:string;sourceControls:ReactNode;status:string;busy:boolean;agentRunning?:boolean;pipelineMessage?:string;loading?:string;onChange:(document:StudioDocument)=>void;onChat:(request:{conversationId:string;text:string;modelAnchor?:ModelAnchor;sourceSelection?:Selection;requestId:string})=>Promise<StudioDocument>;onProposal:(id:string,decision:"apply"|"reject")=>Promise<StudioDocument>;onExport:()=>void;onLeave:()=>Promise<void>;onManage:()=>Promise<void>;onSource:(id:string)=>void};
const emptyEntity:Entity={id:"",kind:"procedure",title:"Study",subtitle:"",description:"",evidence:{page:1,rects:[],quote:""},fields:[],x:0,y:0,w:1,h:1};
const storageKey="build-study-evidence-notes-v3";
const styles=(r:Rect)=>({left:`${r.x}%`,top:`${r.y}%`,width:`${r.w}%`,height:`${r.h}%`});

export default function Workspace({studio}:{studio?:ConnectedStudio}){
 const studioRef=useRef(studio);useEffect(()=>{studioRef.current=studio;},[studio]);
 const study=studio?.initialDocument.model||exampleStudy;
 const overview=modelOverview(study),reviewIssues=modelIssues(study);
 const pageNumber=(n:number)=>studio?n:1160+n;
 const initial=studio?.initialDocument;
 const initialConversation=initial?.conversations.find(c=>c.id===initial.activeConversationId)||initial?.conversations[0];
 const [demoPages,setPages]=useState<Page[]>([]);
 const pages=studio?.pages||demoPages;
 const [page,setPage]=useState(initialConversation?.sourceSelection?.page||(studio?1:3));
 const [sourceZoom,setSourceZoom]=useState(100);
 const [tool,setTool]=useState<"text"|"region">("text");
 const [selected,setSelected]=useState(initialConversation?.selected||study.entities[0]?.id||"");
 const [modelAnchor,setModelAnchor]=useState<ModelAnchor|null>(initialConversation?.modelAnchor||null);
 const [responses,setResponses]=useState<Record<string,ReviewResponse>>(initial?.reviewResponses||{});
 const [theme,setTheme]=useState("system");
 const [language,setLanguage]=useState<Language>("en");
 const t=translator(language);
 const [ready,setReady]=useState(Boolean(studio));
 const [conversationId,setConversationId]=useState(initialConversation?.id||(studio?crypto.randomUUID():"first-conversation"));
 const [conversations,setConversations]=useState<Conversation[]>(initial?.conversations||[]);
 const [historyOpen,setHistoryOpen]=useState(false);
 const [historySearch,setHistorySearch]=useState("");
 const [commenting,setCommenting]=useState(false);
 const sessions=useRef<Conversation[]>(initial?.conversations||[]);
 const settings=useRef<HTMLDialogElement>(null);
 const studies=useRef<HTMLDialogElement>(null);
 const [studiesOpen,setStudiesOpen]=useState(false);
 const messageScroll=useRef<HTMLDivElement>(null);
 const [selection,setSelection]=useState<Selection|null>(initialConversation?.sourceSelection||null);
 const [comment,setComment]=useState("");
 const [notes,setNotes]=useState<Note[]>(initial?.annotations||[]);
 const [activeNote,setActiveNote]=useState<string|null>(null);
 const [showNotes,setShowNotes]=useState(false);
 const [messages,setMessages]=useState<Message[]>(initialConversation?.messages||[]);
 const [input,setInput]=useState(initialConversation?.draft||"");
 const [agentOpen,setAgentOpen]=useState(true);
 const [loadError,setLoadError]=useState("");
 const [saveError,setSaveError]=useState("");
 const [agentError,setAgentError]=useState("");
 const paperRef=useRef<HTMLDivElement>(null);
 const sourceScroll=useRef<HTMLDivElement>(null);
 const commentInput=useRef<HTMLTextAreaElement>(null);
 const agentInput=useRef<HTMLTextAreaElement>(null);
 const drawing=useRef<{x:number;y:number}|null>(null);
 const noteSeq=useRef(0);
 const sending=useRef(false);
 const entity=study.entities.find(e=>e.id===selected)||emptyEntity;
 const currentPage=pages.find(p=>p.page===page);
 const note=notes.find(n=>n.id===activeNote);
 const focusedEvidence=selection?.kind==="evidence"?selection:null;
 const evidenceForPage=(e:Entity["evidence"])=>e.rects.length?e.rects:quoteRects(currentPage?.words||[],e.quote);
 useEffect(()=>{let cancelled=false;Promise.resolve().then(()=>{if(cancelled)return;try{const value=localStorage.getItem("build-study-theme");if(value&&["light","dark","system"].includes(value))setTheme(value);const locale=localStorage.getItem("build-study-language");if(locale==="en"||locale==="zh")setLanguage(locale);}catch{/* Preferences are optional. */}});return()=>{cancelled=true;};},[]);
 useEffect(()=>{if(!pages.length||pages.some(p=>p.page===page))return;window.getSelection()?.removeAllRanges();Promise.resolve().then(()=>setPage(pages[0].page));},[pages,page]);
 function clearPaperTextSelection(){
  const nativeSelection=window.getSelection();
  if(nativeSelection && paperRef.current && (paperRef.current.contains(nativeSelection.anchorNode)||paperRef.current.contains(nativeSelection.focusNode))) nativeSelection.removeAllRanges();
 }
 function showPage(nextPage:number){
  // Release ranges inside the OCR layer before React replaces its page-specific spans.
  if(nextPage!==page) clearPaperTextSelection();
  setPage(nextPage);
 }
 useEffect(()=>{
  if(studioRef.current)return;
  let cancelled=false;
  Promise.resolve().then(()=>{
   if(cancelled)return;
   try{
    const saved=JSON.parse(localStorage.getItem(chatKey)||"null");
    const loaded:Conversation[]=Array.isArray(saved?.sessions)?saved.sessions.filter((c:Conversation)=>c&&typeof c.id==="string"&&typeof c.title==="string"&&Array.isArray(c.messages)&&exampleStudy.entities.some(e=>e.id===c.selected)):[];
    sessions.current=loaded;setConversations(loaded);
    const active=loaded.find(c=>c.id===saved?.activeId)||loaded[0];
    if(active){setConversationId(active.id);setMessages(active.messages);setInput(active.draft||"");setModelAnchor(active.modelAnchor);setSelection(active.sourceSelection);setSelected(active.selected);setPage(active.sourceSelection?.page||exampleStudy.entities.find(e=>e.id===active.selected)!.evidence.page);}
    const locale=localStorage.getItem("build-study-language");if(locale==="en"||locale==="zh")setLanguage(locale);
   }catch{setSaveError("Saved conversations could not be loaded.");}
   setReady(true);
  });
  return()=>{cancelled=true;};
 },[]);
 useEffect(()=>{
  if(!ready)return;
  const previous=sessions.current.find(c=>c.id===conversationId);
  const title=messages.find(m=>m.role==="user")?.text.slice(0,42)||"";
  const current:Conversation={id:conversationId,title:previous?.title||title,updatedAt:new Date().toISOString(),messages,draft:input,modelAnchor,sourceSelection:selection,selected};
  sessions.current=[current,...sessions.current.filter(c=>c.id!==conversationId)];
  if(studioRef.current){
   const connected=studioRef.current;
   connected.onChange({...connected.initialDocument,model:study,annotations:notes,reviewResponses:responses,activeConversationId:conversationId,conversations:sessions.current.map(c=>({...c,messages:c.messages.map((m,i)=>({...m,id:m.id||`${c.id}-${i}`,createdAt:m.createdAt||c.updatedAt}))})) as StudioConversation[]});return;
  }
  const snapshot=JSON.stringify({activeId:conversationId,sessions:sessions.current});
  Promise.resolve().then(()=>localStorage.setItem(chatKey,snapshot)).catch(()=>setSaveError("Conversation could not be saved. Export to keep this session."));
 },[ready,conversationId,messages,input,modelAnchor,selection,selected,notes,responses,study]);
 useEffect(()=>{messageScroll.current?.scrollTo({top:messageScroll.current.scrollHeight,behavior:"smooth"});},[messages]);
 useEffect(()=>{
  if(studioRef.current)return;
  let cancelled=false;
  fetch("/build-preview/anchoring/pages.json").then(r=>{if(!r.ok)throw new Error("Pages unavailable");return r.json();}).then((data:Page[])=>{
   if(cancelled)return;setPages(data);
   try { const savedTheme=localStorage.getItem("build-study-theme"); if(savedTheme && ["light","dark","system"].includes(savedTheme))setTheme(savedTheme);
    const savedResponses=JSON.parse(localStorage.getItem("build-study-review-v4")||"{}");
    if(savedResponses && typeof savedResponses==="object")setResponses(Object.fromEntries(Object.entries(savedResponses).filter(([id,value])=>modelIssues(exampleStudy).some(i=>i.id===id)&&value&&typeof value==="object"&&"text" in value&&typeof value.text==="string")) as Record<string,ReviewResponse>);
   } catch { setSaveError("Saved preferences or review responses could not be loaded."); }
   try{const saved=JSON.parse(localStorage.getItem(storageKey)||"[]");if(Array.isArray(saved))setNotes(saved.filter(n=>typeof n.id==="string"&&typeof n.comment==="string"&&Array.isArray(n.rects)&&exampleStudy.entities.some(e=>e.id===n.entity)));}catch{setSaveError("Saved annotations could not be loaded. New comments will remain available in this session.");}
  }).catch(()=>{if(!cancelled)setLoadError("Could not load the source pages. Reload to try again.");});return()=>{cancelled=true;};
 },[]);
 useEffect(()=>{
  const rect=(focusedEvidence?.page===page?(focusedEvidence.rects[0]||quoteRects(currentPage?.words||[],focusedEvidence.text)[0]):null)??note?.rects[0]??(entity.evidence.page===page?(entity.evidence.rects[0]||quoteRects(currentPage?.words||[],entity.evidence.quote)[0]):null);
  if(!rect||!paperRef.current||!sourceScroll.current)return;
  const target=paperRef.current.offsetTop+rect.y/100*paperRef.current.offsetHeight-90;
  sourceScroll.current.scrollTo({top:Math.max(0,target),behavior:"smooth"});
 },[selected,page,sourceZoom,pages,activeNote,note,entity,focusedEvidence,currentPage]);
 function newConversation(){setConversationId(crypto.randomUUID());setMessages([]);setInput("");setModelAnchor(null);setSelection(null);setActiveNote(null);setCommenting(false);setHistoryOpen(false);setAgentOpen(true);requestAnimationFrame(()=>agentInput.current?.focus());}
 function switchConversation(c:Conversation){if(c.sourceSelection?.sourceId)studio?.onSource(c.sourceSelection.sourceId);setConversationId(c.id);setMessages(c.messages);setInput(c.draft||"");setModelAnchor(c.modelAnchor);setSelection(c.sourceSelection);setSelected(c.selected);setActiveNote(null);showPage(c.sourceSelection?.page||(study.entities.find(e=>e.id===c.selected)||emptyEntity).evidence.page);setHistoryOpen(false);setCommenting(false);}
 function restoreContext(m:Message){if(m.sourceSelection?.sourceId)studio?.onSource(m.sourceSelection.sourceId);setHistoryOpen(false);if(m.entityId)setSelected(m.entityId);setModelAnchor(m.modelAnchor||null);setSelection(m.sourceSelection||null);setActiveNote(null);if(m.sourceSelection)showPage(m.sourceSelection.page);else if(m.modelAnchor?.entityIds[0]){const e=study.entities.find(e=>e.id===m.modelAnchor!.entityIds[0]);if(e){showPage(e.evidence.page);setSelected(e.id);}}setCommenting(false);agentInput.current?.focus();}
 function clearContext(){setModelAnchor(null);setSelection(null);setActiveNote(null);setCommenting(false);window.getSelection()?.removeAllRanges();}
 function contextLabel(anchor:ModelAnchor|null,source:Selection|null){return anchor?`${t(anchor.kind==="lasso"?"Circled region":"Model selection")} · ${anchor.entityIds.length} ${t("objects")}`:source?`${t("Source selection")} · p. ${pageNumber(source.page)}`:"";}
 function choose(id:string){const next=study.entities.find(e=>e.id===id);if(!next)return;if(next.evidence.sourceId)studio?.onSource(next.evidence.sourceId);setSelected(id);showPage(next.evidence.page);setSelection(null);setActiveNote(null);setShowNotes(false);setComment("");setCommenting(false);}
 function changePage(n:number){showPage(n);setSelection(null);setActiveNote(null);sourceScroll.current?.scrollTo({top:0});}
 function store(next:Note[]){setNotes(next);if(studio)return;try{localStorage.setItem(storageKey,JSON.stringify(next));setSaveError("");}catch{setSaveError("Browser storage is unavailable. Export your annotations to keep them.");}}
 function addNote(){if(!selection||!comment.trim())return;const item:Note={...selection,id:`note-${Date.now()}-${++noteSeq.current}`,entity:selected,comment:comment.trim(),createdAt:new Date().toISOString()};store([...notes,item]);setActiveNote(item.id);setCommenting(false);setSelection(null);setComment("");setShowNotes(false);}
 function openNote(n:Note){if(n.sourceId)studio?.onSource(n.sourceId);setModelAnchor(null);setActiveNote(n.id);setSelected(n.entity);showPage(n.page);setSelection(null);setShowNotes(false);}
 function point(event:PointerEvent<HTMLDivElement>){const r=event.currentTarget.getBoundingClientRect();return{x:Math.max(0,Math.min(100,(event.clientX-r.left)/r.width*100)),y:Math.max(0,Math.min(100,(event.clientY-r.top)/r.height*100))};}
 function begin(event:PointerEvent<HTMLDivElement>){if(tool!=="region"||studio?.busy)return;const p=point(event);drawing.current=p;setCommenting(false);setActiveNote(null);setModelAnchor(null);setSelection({sourceId:studio?.sourceId,page,kind:"region",text:"",rects:[{...p,w:0,h:0}]});event.currentTarget.setPointerCapture(event.pointerId);}
 function move(event:PointerEvent<HTMLDivElement>){if(!drawing.current)return;const a=drawing.current,p=point(event);setSelection({sourceId:studio?.sourceId,page,kind:"region",text:"",rects:[{x:Math.min(a.x,p.x),y:Math.min(a.y,p.y),w:Math.abs(a.x-p.x),h:Math.abs(a.y-p.y)}]});}
 function end(event:PointerEvent<HTMLDivElement>){if(!drawing.current)return;const a=drawing.current,p=point(event);drawing.current=null;setTool("text");const rect={x:Math.min(a.x,p.x),y:Math.min(a.y,p.y),w:Math.abs(a.x-p.x),h:Math.abs(a.y-p.y)};if(rect.w<.5||rect.h<.5){setSelection(null);return;}const text=(currentPage?.words||[]).filter(word=>word.x+word.w/2>=rect.x&&word.x+word.w/2<=rect.x+rect.w&&word.y+word.h/2>=rect.y&&word.y+word.h/2<=rect.y+rect.h).map(word=>word.t).join(" ");setSelection({sourceId:studio?.sourceId,page,kind:"region",text,rects:[rect]});}
 function captureText(){if(tool!=="text"||!paperRef.current||studio?.busy)return;const sel=window.getSelection();if(!sel||sel.isCollapsed||!sel.rangeCount||!paperRef.current.contains(sel.anchorNode)||!paperRef.current.contains(sel.focusNode))return;
 const text=sel.toString().trim();if(!text)return;const base=paperRef.current.getBoundingClientRect();const rects=Array.from(sel.getRangeAt(0).getClientRects()).slice(0,64).filter(r=>r.width>1&&r.height>1).map(r=>({x:Math.max(0,(r.left-base.left)/base.width*100),y:Math.max(0,(r.top-base.top)/base.height*100),w:Math.min(100-Math.max(0,(r.left-base.left)/base.width*100),r.width/base.width*100),h:Math.min(100-Math.max(0,(r.top-base.top)/base.height*100),r.height/base.height*100)}));
 setCommenting(false);setModelAnchor(null);setSelection({sourceId:studio?.sourceId,page,kind:"text",text:text.slice(0,8000),rects});setActiveNote(null);
 }
 async function ask(text:string,anchored:ModelAnchor|null=modelAnchor){if(!text.trim()||!ready||studio?.busy||studio?.agentRunning||sending.current)return;
 if(studio){sending.current=true;try{setAgentError("");const doc=await studio.onChat({conversationId,text,modelAnchor:anchored||undefined,sourceSelection:!anchored?(selection||note||undefined):undefined,requestId:crypto.randomUUID()});const convo=doc.conversations.find(c=>c.id===conversationId);if(convo){setMessages(convo.messages);sessions.current=doc.conversations;}setInput("");setHistoryOpen(false);setAgentOpen(true);}catch(error){setAgentError(error instanceof Error?error.message:"Message could not be sent.");}finally{sending.current=false;}return;}
 const ids=anchored?.entityIds||[];
 const context=anchored?`${anchored.kind==="lasso"?"Circled region":anchored.kind==="issue"?"Review issue":"Study model"} · ${ids.map(id=>(overview.cards[id]?.title||id)).join(" + ")||"canvas selection"}`:`${entity.title}${selection?` · selected source, p. ${pageNumber(selection.page)}`:note?` · annotation, p. ${pageNumber(note.page)}`:""}`;
 const evidence=anchored?study.entities.filter(e=>ids.includes(e.id)).map(e=>e.evidence):[entity.evidence];
 setAgentError(language==="zh"?"这是离线示例。请在「我的研究 / 登录」中新建研究，使用真实构建 agent。":"This is an offline example. Create a study in Studies / Account to use the real build agent.");
 setMessages(prev=>[...prev,{id:crypto.randomUUID(),createdAt:new Date().toISOString(),entityId:selected,role:"user",text,context,modelAnchor:anchored||undefined,sourceSelection:!anchored?(selection||note||undefined):undefined,evidence}]);setInput("");setAgentOpen(true);setHistoryOpen(false);
 }

 async function decideProposal(id:string,decision:"apply"|"reject"){
  if(!studio||studio.busy)return;
  try{setAgentError("");const doc=await studio.onProposal(id,decision);sessions.current=doc.conversations;const active=doc.conversations.find(c=>c.id===conversationId);if(active){setMessages(active.messages);setSelected(active.selected);setModelAnchor(active.modelAnchor);setSelection(active.sourceSelection);}}
  catch(error){setAgentError(error instanceof Error?error.message:"Could not apply proposal.");}
 }
 function saveResponse(id:string,text:string){const next={...responses,[id]:{text,savedAt:new Date().toISOString()}};setResponses(next);if(studio)return;try{localStorage.setItem("build-study-review-v4",JSON.stringify(next));setSaveError("");}catch{setSaveError("Review response is kept in this session only. Export to preserve it.");}}
 function changeTheme(value:string){setTheme(value);try{localStorage.setItem("build-study-theme",value);}catch{setSaveError("Theme preference cannot be saved in this browser.");}}
 function exportSchema(){if(studio){studio.onExport();return;}const url=URL.createObjectURL(new Blob([JSON.stringify({schema:study,annotations:notes,review:{issues:reviewIssues,responses,pendingApplication:Object.keys(responses)},conversations:sessions.current,conversation:messages,executable:false,stage:"source-backed interface prototype"},null,2)],{type:"application/json"}));const a=document.createElement("a");a.href=url;a.download="anchoring-study-schema-and-annotations.json";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 const evidenceRects=entity.evidence.page===page&&(!studio||entity.evidence.sourceId===studio.sourceId)?evidenceForPage(entity.evidence):[];
 return <LanguageContext.Provider value={language}><div className={s.shell} data-theme={theme} data-studio-workspace={studio?.workspaceId} translate="no" lang={language==="zh"?"zh-CN":"en"} onKeyDown={e=>{if(e.key==="Escape"&&!settings.current?.open&&!studio?.busy){clearContext();setHistoryOpen(false);}}}>
  <header className={s.header}><Link href="/build" onClick={studio?e=>{e.preventDefault();if(!studio.busy)void studio.onLeave().catch(error=>setSaveError(error instanceof Error?error.message:"Save failed."));}:undefined} className={s.brand}><span>HumanStudy-Hub</span></Link><span className={s.headerDivider}>/</span><span>{t("Build Study")}</span><strong>{study.title}</strong>{studio&&<small role="status">{t(studio.busy?"Working…":studio.status)}</small>}<button disabled={studio?.busy} onClick={async()=>{try{if(studio)await studio.onManage();setStudiesOpen(true);studies.current?.showModal();}catch(error){setSaveError(error instanceof Error?error.message:"Save failed.");}}}>{language==="zh"?"我的研究 / 登录":"Studies / Account"}</button><button className={s.settingsButton} aria-label={t("Settings")} title={t("Settings")} onClick={()=>settings.current?.showModal()}><UiIcon name="settings"/></button><button disabled={studio?.busy} data-event="workspace.export" onClick={exportSchema}>{t("Export draft ↗")}</button></header>
  <fieldset className={s.workspace} disabled={studio?.busy} aria-busy={studio?.busy} aria-label={t("Study workspace")}>
   <aside className={`${s.agent} ${!agentOpen?s.agentCollapsed:""}`} aria-label={t("Study agent")}><div className={s.agentHeader}><button onClick={()=>setAgentOpen(!agentOpen)} aria-label={agentOpen?t("Collapse agent"):t("Expand agent")}><UiIcon name="panel"/></button>{agentOpen&&<><strong>{t("Study agent")}</strong><div className={s.agentActions}><button data-event="chat.history" title={t("History")} aria-label={t("History")} aria-expanded={historyOpen} onClick={()=>{setConversations(sessions.current);setHistoryOpen(!historyOpen);}}><UiIcon name="history"/></button><button data-event="chat.new" title={t("New chat")} aria-label={t("New chat")} onClick={newConversation}><UiIcon name="new"/></button></div></>}</div>{agentOpen&&<>
    {historyOpen?<div className={s.history}><div><strong>{t("History")}</strong><button aria-label={t("Close")} onClick={()=>setHistoryOpen(false)}>×</button></div><input aria-label={t("Search conversations…")} placeholder={t("Search conversations…")} value={historySearch} onChange={e=>setHistorySearch(e.target.value)}/>{conversations.filter(c=>(c.title||t("Untitled conversation")).toLowerCase().includes(historySearch.toLowerCase())).map(c=><button key={c.id} className={c.id===conversationId?s.currentChat:""} onClick={()=>switchConversation(c)}><span>{c.title||t("Untitled conversation")}</span><small>{new Date(c.updatedAt).toLocaleDateString(language==="zh"?"zh-CN":"en-US",{month:"short",day:"numeric"})} · {c.messages.filter(m=>m.role==="user").length} ↗</small></button>)}</div>:
    <div className={s.messages} ref={messageScroll} aria-live="polite">{messages.length===0&&<div className={s.emptyChat}><h2>{t("Let’s build your study.")}</h2><p>{t("Select a passage or a part of the model.")}</p></div>}{messages.map((m,i)=><div key={m.id||i} className={m.role==="user"?s.userMessage:s.agentMessage}>{(m.modelAnchor||m.sourceSelection)&&<button className={s.messageReference} title={t("Return to selection")} onClick={()=>restoreContext(m)}><UiIcon size={13} name={m.modelAnchor?.kind==="lasso"?"circle":m.sourceSelection?"source":"selection"}/>{contextLabel(m.modelAnchor||null,m.sourceSelection||null)} ↗</button>}<p>{m.text}</p>{m.proposal&&<div className={s.proposal}><strong>{t(m.proposal.changesModel===false?"Proposed materials":"Proposed model")}</strong><p>{m.proposal.summary}</p><small>{m.proposal.changesModel===false?m.proposal.artifacts?.length:m.proposal.model.entities.length} {t(m.proposal.changesModel===false?"files":"objects")} · {t(m.proposal.status)}</small>{m.proposal.changesModel!==false&&<details><summary>{t("Review proposed model")}</summary>{m.proposal.model.entities.map(object=><section key={object.id}><strong>{object.title}</strong><p>{object.description}</p><dl>{object.fields.map((field,index)=><div key={index}><dt>{field.name}</dt><dd>{field.value} <small>{field.status}</small></dd></div>)}</dl>{object.evidence.quote&&<blockquote>{object.evidence.quote} · p. {object.evidence.page}</blockquote>}</section>)}<p>{m.proposal.model.procedure.map(step=>step.name).join(" → ")}</p></details>}{m.proposal.artifacts&&<details><summary>{t("Review materials")} ({m.proposal.artifacts.length})</summary>{m.proposal.artifacts.map(artifact=><section key={artifact.id}><strong>{artifact.title}</strong><small>{artifact.filename}</small><pre>{artifact.content}</pre></section>)}</details>}{studio&&m.proposal.status==="pending"&&<div><button disabled={studio.busy} onClick={()=>void decideProposal(m.proposal!.id,"apply")}>{t("Apply")}</button><button disabled={studio.busy} onClick={()=>void decideProposal(m.proposal!.id,"reject")}>{t("Reject")}</button></div>}</div>}</div>)}</div>}
    {studio?.pipelineMessage&&<p className={s.agentIntro} role="status" style={{padding:"8px 16px"}}>{studio.pipelineMessage}</p>}{agentError&&<p className={s.error} role="alert">{agentError}</p>}<form data-event="chat.composer" className={s.composer} onSubmit={e=>{e.preventDefault();ask(input);}}>{(modelAnchor||selection)&&<div className={s.sharedContext}><UiIcon size={15} name={modelAnchor?.kind==="lasso"?"circle":selection?"source":"selection"}/><div><strong>{contextLabel(modelAnchor,selection)}</strong><small>{modelAnchor?modelAnchor.entityIds.map(id=>t((overview.cards[id]?.title||id))).join(" · "):selection?.text.slice(0,90)||t("Box selection")}</small></div><button type="button" aria-label={t("Clear context")} onClick={clearContext}>×</button></div>}<textarea ref={agentInput} aria-label={t("Message study agent")} disabled={studio?.busy} placeholder={t("Ask about your study…")} value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();ask(input);}}}/><div><small title={t("Saved on this device")}>{studio?t(studio.agentRunning?"Building study…":studio.busy?"Working…":"Study-building agent"):(language==="zh"?"示例 · AI 离线":"Example · AI offline")}</small><button disabled={!input.trim()||!ready||studio?.busy||studio?.agentRunning} aria-label={t("Send message")}>↑</button></div></form></>}</aside>
   <section data-event="source.panel" className={s.source} aria-label="Annotatable original paper">
    <div className={s.sectionBar}><div><strong>{t("Original paper")}</strong><small>{studio?studio.initialDocument.sources.find(source=>source.id===studio.sourceId)?.name:(study.source.authors||study.source.title)}</small></div><button className={showNotes?s.active:""} onClick={()=>setShowNotes(!showNotes)}>{t("Comments")} <span>{notes.length}</span></button></div>
    {studio?.sourceControls}
    <div data-event="source.toolbar" className={s.sourceTools}><div className={s.toolGroup}><button className={tool==="text"?s.active:""} onClick={()=>setTool("text")} aria-pressed={tool==="text"}>I̲ {t("Text")}</button><button className={tool==="region"?s.active:""} onClick={()=>setTool("region")} aria-pressed={tool==="region"}>▧ {t("Box")}</button></div><div className={s.pageControl}><button onClick={()=>changePage(Math.max(1,page-1))} disabled={page===1} aria-label={t("Previous page")}>‹</button><span>{page} / {pages.length||"–"}</span><button onClick={()=>changePage(Math.min(pages.length,page+1))} disabled={page>=pages.length} aria-label={t("Next page")}>›</button></div><select aria-label={t("Source zoom")} value={sourceZoom} onChange={e=>setSourceZoom(Number(e.target.value))}>{[100,125,150,200].map(z=><option key={z} value={z}>{z===100?t("Fit width"):`${z}%`}</option>)}</select></div>
    <div className={s.sourceBody}><nav className={s.minimap} aria-label="Original paper minimap">{pages.map(p=><button className={page===p.page?s.currentPage:""} key={p.page} onClick={()=>changePage(p.page)} aria-label={`Open source page ${p.page}`}><span className={s.thumb}><Image src={p.image} alt="" width={p.width} height={p.height} unoptimized/>{notes.filter(n=>n.page===p.page&&(!studio||n.sourceId===studio.sourceId)).map(n=><i key={n.id} style={{top:`${n.rects[0]?.y??0}%`}}/>)}</span><small>{p.page}</small>{notes.some(n=>n.page===p.page&&(!studio||n.sourceId===studio.sourceId))&&<b>{notes.filter(n=>n.page===p.page&&(!studio||n.sourceId===studio.sourceId)).length}</b>}</button>)}</nav>
    <div className={s.sourceScroll} ref={sourceScroll}>
     {loadError&&<p className={s.error}>{loadError}</p>}
     {!currentPage&&!loadError&&<div className={s.loading}>{studio?studio.loading||t("Upload a paper to begin."):t("Loading original pages…")}</div>}
     {currentPage&&<div data-event="source.page" className={s.paperSizing} style={{width:`${sourceZoom}%`}}><div className={`${s.paper} ${tool==="region"?s.boxTool:""}`} ref={paperRef} style={{aspectRatio:`${currentPage.width}/${currentPage.height}`}} onPointerDown={begin} onPointerMove={move} onPointerUp={end} onPointerCancel={()=>{drawing.current=null;setTool("text");}} onKeyUp={captureText}>
      <Image src={currentPage.image} alt={`Original page ${pageNumber(page)}, ${study.source.title}`} width={currentPage.width} height={currentPage.height} unoptimized draggable={false}/>
      <div key={`${studio?.sourceId||"demo"}-${page}`} className={s.textLayer} aria-label={t("Selectable OCR text")} onPointerUp={()=>requestAnimationFrame(captureText)}>{currentPage.words.map((word,i)=><span key={`${page}-${i}`} style={{left:`${word.x}%`,top:`${word.y}%`,width:`${word.w}%`,height:`${word.h}%`,fontSize:`${word.h*currentPage.height/currentPage.width*.88}cqw`}}>{word.t}{" "}</span>)}</div>
      {evidenceRects.map((r,i)=><div key={`e-${i}`} className={s.evidenceBox} style={styles(r)}/>)}
      {notes.filter(n=>n.page===page&&(!studio||n.sourceId===studio.sourceId)).map(n=><div key={n.id}>{n.rects.map((r,i)=><div key={i} className={`${s.savedHighlight} ${activeNote===n.id?s.focusedHighlight:""}`} style={styles(r)}/>)}<button className={s.notePin} style={{left:`${Math.min(95,n.rects[0]?.x??0)}%`,top:`${n.rects[0]?.y??0}%`}} onPointerDown={e=>e.stopPropagation()} onClick={e=>{e.stopPropagation();openNote(n);}} aria-label={`Open annotation ${notes.indexOf(n)+1}`}>{notes.indexOf(n)+1}</button></div>)}
      {selection?.page===page&&(!studio||selection.sourceId===studio.sourceId)&&(selection.rects.length?selection.rects:quoteRects(currentPage.words,selection.text)).map((r,i)=><div key={`s-${i}`} className={s.selectionBox} style={styles(r)}/>)}
     </div></div>}
    </div></div>
    {showNotes&&<div className={s.notesPanel}><div><strong>{t("Annotations")}</strong><button aria-label={t("Close annotations")} onClick={()=>setShowNotes(false)}>×</button></div>{notes.length===0?<p>{t("Drag over text or draw a box")}</p>:notes.map((n,i)=><button className={s.noteListItem} key={n.id} onClick={()=>openNote(n)}><small>{i+1} · p. {pageNumber(n.page)} → {t((overview.cards[n.entity]?.title||n.entity))}</small><span>{n.comment}</span></button>)}</div>}
    {selection&&!commenting&&<div className={s.selectionBar}><div><UiIcon size={14} name="source"/><strong>{contextLabel(null,selection)}</strong><button aria-label={t("Clear context")} onClick={clearContext}>×</button></div>{selection.text&&<blockquote>{selection.text.slice(0,150)}</blockquote>}<footer><span>↔ {t("Shared with chat")}</span><button onClick={()=>{setModelAnchor(null);setAgentOpen(true);setHistoryOpen(false);requestAnimationFrame(()=>agentInput.current?.focus());}}>{t("Ask AI")} ↗</button><button onClick={()=>{setCommenting(true);requestAnimationFrame(()=>commentInput.current?.focus());}}>{t("Comment")} ＋</button></footer></div>}
    {selection&&commenting&&<div data-event="source.comment" className={s.annotationComposer}><div className={s.annotationHeading}><span>{selection.kind==="region"?t("Box selection"):t("Selected passage")} · p. {pageNumber(selection.page)}</span><button aria-label={t("Cancel selection")} onClick={()=>{setSelection(null);setComment("");window.getSelection()?.removeAllRanges();}}>×</button></div>{selection.text&&<blockquote>{selection.text.slice(0,180)}{selection.text.length>180?"…":""}</blockquote>}<label>{t("Link to")} <select aria-label={t("Annotation linked object")} value={selected} onChange={e=>setSelected(e.target.value)}><option value="">{t("No linked object")}</option>{study.entities.map(e=><option key={e.id} value={e.id}>{t((overview.cards[e.id]?.title||e.title))}</option>)}</select></label><textarea ref={commentInput} aria-label={t("Add a note…")} value={comment} onChange={e=>setComment(e.target.value)} placeholder={t("Add a note…")}/><div className={s.annotationActions}><button onClick={()=>{setModelAnchor(null);setInput(comment||`Please examine this selected source region in relation to ${entity.title}.`);setAgentOpen(true);agentInput.current?.focus();}}>{t("Discuss with agent ↗")}</button><button className={s.primary} disabled={!comment.trim()} onClick={addNote}>{t("Add comment")}</button></div></div>}
    {note&&!selection&&!showNotes&&<div className={s.annotationThread}><div><small>{t("Comment")} {notes.indexOf(note)+1} · p. {pageNumber(note.page)}</small><button aria-label={t("Close comment")} onClick={()=>setActiveNote(null)}>×</button></div><p>{note.comment}</p>{note.entity&&<button onClick={()=>{setSelected(note.entity);setModelAnchor({kind:"objects",entityIds:[note.entity]});}}>{t("Link to")} {t((overview.cards[note.entity]?.title||note.entity))} ↗</button>}<button onClick={()=>{setSelection(note);setActiveNote(null);setComment("");setCommenting(true);}}>{t("Add another comment")}</button>{note.entity&&<button onClick={()=>store(notes.map(item=>item.id===note.id?{...item,entity:""}:item))}>{t("Unlink object")}</button>}</div>}
    <div className={s.sourceFoot}><span><i/> {t("Source link")} <b/> {t("Your annotation")}</span><span>{t(studio?"Original PDF · text & regions":"Scanned PDF · selectable OCR")}</span></div>{saveError&&<div className={s.error}>{saveError}</div>}
   </section>
   <StudyModel artifacts={studio?.initialDocument.artifacts} onDiscussArtifact={studio?artifact=>{clearContext();setInput(`${t("About this material")}: ${artifact.title} (${artifact.id}) — `);setAgentOpen(true);setHistoryOpen(false);requestAnimationFrame(()=>agentInput.current?.focus());}:undefined} model={study} busy={studio?.busy} prompt={input} setPrompt={setInput} selected={selected} anchor={modelAnchor} responses={responses}
    onSelect={anchor=>{setModelAnchor(anchor);if(anchor?.entityIds[0])choose(anchor.entityIds[0]);}}
    onSource={(id,evidence)=>{choose(id);if(evidence){if(evidence.sourceId)studio?.onSource(evidence.sourceId);setModelAnchor(null);showPage(evidence.page);setSelection({sourceId:evidence.sourceId||studio?.sourceId,page:evidence.page,rects:evidence.rects,text:evidence.quote,kind:"evidence"});}}}
    onAsk={(text,anchor)=>ask(text,anchor)} onRespond={saveResponse}/>

  </fieldset>
  <dialog ref={studies} className={`${s.settingsDialog} ${s.studiesDialog}`} onClose={()=>setStudiesOpen(false)}><form method="dialog" className={s.dialogHeading}><strong>{language==="zh"?"研究":"Studies"}</strong><button aria-label={t("Close")}>×</button></form>{studio?<Link href="/build/example">{language==="zh"?"打开示例研究":"Open example study"}</Link>:<p>{language==="zh"?"正在查看示例 · 更改保存在此设备":"Viewing example study · changes saved on this device"}</p>}{studiesOpen&&<StudioHome embedded/>}</dialog>
  <dialog ref={settings} className={s.settingsDialog}><form method="dialog" className={s.dialogHeading}><strong>{t("Settings")}</strong><button aria-label={t("Close")}>×</button></form><label>{t("Appearance")}<select aria-label={t("Appearance")} value={theme} onChange={e=>changeTheme(e.target.value)}><option value="system">◐ {t("System")}</option><option value="light">☀ {t("Light")}</option><option value="dark">☾ {t("Dark")}</option></select></label><label>{t("Language")}<select aria-label={t("Language")} value={language} onChange={e=>{const next=e.target.value as Language;setLanguage(next);try{localStorage.setItem("build-study-language",next);}catch{setSaveError("Language preference could not be saved.");}}}><option value="en">English</option><option value="zh">简体中文</option></select></label><small>{t("Source quotations stay in their original language.")}</small><div className={s.shortcuts}><strong>{t("Keyboard shortcuts")}</strong><p><kbd>Enter</kbd>{t("Send")}</p><p><kbd>Shift ↵</kbd>{t("New line")}</p><p><kbd>Esc</kbd>{t("Clear selection / close")}</p></div><footer>{studio&&<p>{t("Workspace clicks, timing, pointer movement and AI conversations are recorded for platform research.")}</p>}<span>{studio?t("Saved to your account"):t("Saved on this device")}</span><p>{studio?t("Conversations and annotations are saved to your account."):t("Conversations, annotations and preferences are stored in this browser.")}</p></footer></dialog>
 </div></LanguageContext.Provider>;
}
