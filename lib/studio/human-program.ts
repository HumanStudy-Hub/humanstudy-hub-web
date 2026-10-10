import * as contract from './human-program.schema.json';
import type { Evidence, EntityKind, StudySchema } from '@/app/build-preview/study-schema';

export type JsonValue = null | boolean | number | string | JsonValue[] | {[key:string]:JsonValue};
export type ProgramField = {id:string;label:string;value:JsonValue;origin:'verbatim'|'reported'|'derived'|'researcher'|'implementation'|'unknown';state:'confirmed'|'check'|'decision'|'missing';evidenceIds:string[];derivation?:string;studyIds?:string[];extensions?:Record<string,JsonValue>};
export type ProgramNode = {id:string;kind:string;title:string;summary?:string;description?:string;studyIds:string[];fields:ProgramField[];evidenceIds:string[];extensions?:Record<string,JsonValue>};
export type ProgramStep = {id:string;studyId:string;kind:'action'|'sequence'|'repeat'|'branch'|'parallel'|'interaction'|'custom';title:string;actorIds:string[];inputIds:string[];outputIds:string[];visibleIds:string[];children:string[];next:{to:string;when?:string}[];rule?:ProgramField;evidenceIds:string[];extensions?:Record<string,JsonValue>};
export type ProgramEvidence = {id:string;verification?:"verified"|"unverified";sourceId?:string;path?:string;url?:string;locator:{page?:number;pointer?:string;start?:number;end?:number;sheet?:string;cell?:string;region?:string};quote?:string};
export type HumanProgram = {schemaVersion:2;id:string;title:string;intent:'reconstruct'|'codesign';source:StudySchema['source'];studies:{id:string;title:string;type:'empirical'|'analysis'|'unspecified';description?:string;dependsOn?:string[]}[];nodes:ProgramNode[];steps:ProgramStep[];relations:{id:string;from:string;to:string;type:string;label?:string}[];evidence:ProgramEvidence[];issues:{id:string;title:string;severity:'blocking'|'decision'|'check';reason:string;impact:string;suggestedAction:string;studyId?:string;nodeId?:string;fieldId?:string;stepId?:string;evidenceIds:string[]}[];extensions?:Record<string,JsonValue>};

type Rule = { $ref?:string; const?:unknown; enum?:unknown[]; type?:string; minLength?:number; maxLength?:number; pattern?:string; minimum?:number; maximum?:number; maxItems?:number; items?:Rule; properties?:Record<string,Rule>;required?:string[];additionalProperties?:boolean };
const schema=((contract as unknown as {default?:unknown}).default??contract) as Rule&{$defs:Record<string,Rule>};
export const humanProgramContract=schema;
function check(value:unknown,rule:Rule,path:string,depth=0):void {
 const fail=(reason:string):never=>{throw new Error(`${path}: ${reason}`);};
 if(depth>64)fail('structure is too deeply nested');
 if(rule.$ref)return check(value,schema.$defs[rule.$ref.split('/').at(-1)!],path,depth+1);
 if('const' in rule&&value!==rule.const)fail('unsupported schema version');
 if(rule.enum&&!rule.enum.includes(value))fail('invalid choice');
 if(rule.type==='string'){
  if(typeof value!=='string')fail('must be a string');
  const s=value as string,length=[...s].length;if(length<(rule.minLength??0)||length>(rule.maxLength??Infinity)||rule.pattern&&!new RegExp(rule.pattern).test(s))fail('invalid string');
 }
 if(rule.type==='integer'&&(typeof value!=='number'||!Number.isInteger(value)||value<(rule.minimum??-Infinity)||value>(rule.maximum??Infinity)))fail('invalid integer');
 if(rule.type==='array'){
  if(!Array.isArray(value)||value.length>(rule.maxItems??Infinity))fail('invalid array');
  (value as unknown[]).forEach((v,i)=>check(v,rule.items??{},`${path}[${i}]`,depth+1));
 }
 if(rule.type==='object'){
  if(!value||typeof value!=='object'||Array.isArray(value))fail('must be an object');
  const obj=value as Record<string,unknown>;
  for(const key of rule.required??[])if(!(key in obj))fail(`missing ${key}`);
  for(const [key,v] of Object.entries(obj)){
   if(rule.additionalProperties===false&&!Object.hasOwn(rule.properties??{},key))fail(`unknown field ${key}; use extensions`);
   if(rule.properties?.[key])check(v,rule.properties[key],`${path}.${key}`,depth+1);
  }
 }
}
const unique=(ids:string[],where:string)=>{if(new Set(ids).size!==ids.length)throw new Error(`${where}: duplicate ID`);};
export function validateHumanProgram(value:unknown):HumanProgram {
 const serialized=JSON.stringify(value);
 if(!serialized||new TextEncoder().encode(serialized).byteLength>500_000)throw new Error('Human Program exceeds 500 KB; reference large materials as resources');
 const json=JSON.parse(serialized); // Reject NaN/Infinity and undefined by validating the input, not a sanitized clone.
 if(JSON.stringify(json)!==serialized)throw new Error('Invalid JSON');
 function finite(v:unknown,depth=0):void{if(depth>64)throw new Error('Human Program is too deeply nested');if(typeof v==='number'&&!Number.isFinite(v)||v===undefined||typeof v==='function'||typeof v==='bigint')throw new Error('Invalid JSON value');if(v&&typeof v==='object')Object.values(v).forEach(x=>finite(x,depth+1));}
 finite(value);check(value,schema,'program');
 const p=value as HumanProgram;
 for(const [key,items] of Object.entries({studies:p.studies,nodes:p.nodes,steps:p.steps,relations:p.relations,evidence:p.evidence,issues:p.issues}))unique(items.map(i=>i.id),key);
 if(p.relations.length+p.steps.reduce((n,s)=>n+s.next.length+s.children.length,0)>1200)throw new Error("Human Program exceeds 1200 display connections");
 const nodes=new Map(p.nodes.map(n=>[n.id,n])),studies=new Set(p.studies.map(s=>s.id)),steps=new Map(p.steps.map(s=>[s.id,s])),evidence=new Set(p.evidence.map(e=>e.id));
 const refs=(ids:string[],known:ReadonlySet<string>|ReadonlyMap<string,unknown>,where:string)=>{unique(ids,where);for(const id of ids)if(!known.has(id))throw new Error(`${where}: unknown reference ${id}`);};
 const field=(f:ProgramField,where:string)=>{refs(f.evidenceIds,evidence,where);refs(f.studyIds??[],studies,where);if(f.origin==='derived'&&!f.derivation?.trim())throw new Error(`${where}: derived value requires derivation`);};
 for(const n of p.nodes){if(n.id.startsWith('flow:'))throw new Error('Node ID prefix flow: is reserved');refs(n.studyIds,studies,n.id);refs(n.evidenceIds,evidence,n.id);unique(n.fields.map(f=>f.id),n.id);n.fields.forEach(f=>field(f,`${n.id}.${f.id}`));}
 for(const s of p.steps){refs([s.studyId],studies,s.id);for(const ids of [s.actorIds,s.inputIds,s.outputIds,s.visibleIds])refs(ids,nodes,s.id);refs(s.children,steps,s.id);refs(s.next.map(e=>e.to),steps,s.id);refs(s.evidenceIds,evidence,s.id);if(s.rule)field(s.rule,s.id);for(const id of [...s.children,...s.next.map(e=>e.to)])if(steps.get(id)!.studyId!==s.studyId)throw new Error(`${s.id}: cross-study flow edge`);}
 // Nesting is containment, not execution order; repetition lives in explicit repeat nodes.
 const done=new Set<string>();
 const visit=(id:string,active:Set<string>)=>{if(active.has(id))throw new Error('Procedure containment cycle');if(done.has(id))return;for(const child of steps.get(id)!.children)visit(child,new Set([...active,id]));done.add(id);};
 p.steps.forEach(s=>visit(s.id,new Set()));
 const finished=new Set<string>(),byStudy=new Map(p.studies.map(s=>[s.id,s]));
 const studyVisit=(id:string,active:Set<string>)=>{if(active.has(id))throw new Error('Study dependency cycle');if(finished.has(id))return;const deps=byStudy.get(id)!.dependsOn??[];refs(deps,studies,id);for(const dep of deps)studyVisit(dep,new Set([...active,id]));finished.add(id);};
 p.studies.forEach(s=>studyVisit(s.id,new Set()));
 for(const r of p.relations)refs([r.from,...(r.to===r.from?[]:[r.to])],nodes,r.id);
 for(const e of p.evidence){if(!e.sourceId&&!e.path&&!e.url)throw new Error(`${e.id}: source reference is required`);if(e.locator.start!==undefined&&e.locator.end!==undefined&&e.locator.end<e.locator.start)throw new Error(`${e.id}: reversed source range`);}
 for(const i of p.issues){refs(i.evidenceIds,evidence,i.id);if(i.studyId)refs([i.studyId],studies,i.id);if(i.nodeId)refs([i.nodeId],nodes,i.id);if(i.stepId)refs([i.stepId],steps,i.id);if(i.fieldId&&(!i.nodeId||!nodes.get(i.nodeId)?.fields.some(f=>f.id===i.fieldId)))throw new Error(`${i.id}: unknown field reference`);}
 for(const n of p.nodes)for(const f of n.fields)if(['missing','decision'].includes(f.state)&&!p.issues.some(i=>i.nodeId===n.id&&(!i.fieldId||i.fieldId===f.id)))throw new Error(`${n.id}.${f.id}: unresolved field requires a review issue`);
 for(const s of p.steps)if(s.rule&&['missing','decision'].includes(s.rule.state)&&!p.issues.some(i=>i.stepId===s.id))throw new Error(`${s.id}: unresolved rule requires a review issue`);
 return structuredClone(p);
}
export function programJson(value:unknown):string {
 const sort=(v:unknown):unknown=>Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,item])=>[k,sort(item)])):v;
 return JSON.stringify(sort(value));
}
export const programText=(v:unknown)=>typeof v==='string'?v:v===undefined?'':JSON.stringify(v,null,2);
export const programKinds=['background','hypothesis','design','participants','material','procedure','record','variable','analysis','result'] as const;
const preview=(value:string,max:number)=>[...value].slice(0,max).join('');
export function projectHumanProgram(program:HumanProgram):StudySchema {
 const p=program,lookup=new Map(p.nodes.map(n=>[n.id,n]));
 const ev=(ids:string[]):Evidence=>{const e=ids.map(id=>p.evidence.find(e=>e.id===id)).find(e=>e?.sourceId&&e.locator.page&&e.locator.page<=10000&&e.verification==="verified");return {page:e?.locator.page??1,rects:[],quote:preview(e?.quote??'',8000),...(e?.sourceId?{sourceId:e.sourceId}:{})};};
 const status=(f:ProgramField):'reported'|'implementation'|'unresolved'=>f.state==='missing'||f.state==='decision'?'unresolved':f.origin==='reported'||f.origin==='verbatim'?'reported':'implementation';
 const entities:StudySchema['entities']=p.nodes.map(n=>({id:n.id,kind:(programKinds as readonly string[]).includes(n.kind)?n.kind as EntityKind:'design',title:n.title,subtitle:n.summary??'',description:preview(n.description??'',12000),evidence:ev(n.evidenceIds),fields:n.fields.map(f=>({id:f.id,name:f.label,value:preview(programText(f.value),4000),status:status(f)})),x:0,y:0,w:240,h:100,studyIds:n.studyIds}));
 const names=(ids:string[])=>ids.map(id=>lookup.get(id)?.title??id).join(', ');
 for(const step of p.steps){
  const summary=typeof step.rule?.value==='string'?step.rule.value:[names(step.actorIds),names(step.inputIds),names(step.outputIds)].filter(Boolean).join(' → ');
  entities.push({id:`flow:${step.id}`,kind:'procedure',title:step.title,subtitle:preview([step.kind==='action'?'':step.kind,summary].filter(Boolean).join(' · '),240),description:step.rule?preview(programText(step.rule.value),12000):'',evidence:ev(step.evidenceIds),fields:[{name:'Visible information',value:preview(names(step.visibleIds),4000),status:'implementation'},...(step.rule?[{id:step.rule.id,name:step.rule.label,value:preview(programText(step.rule.value),4000),status:status(step.rule)}]:[])],x:0,y:0,w:240,h:100,studyIds:[step.studyId]});
 }
 const procedure=p.steps.map(s=>({id:s.id,entity:`flow:${s.id}`,name:s.title,input:preview(names(s.inputIds),4000),actor:preview(names(s.actorIds),1000),output:preview(names(s.outputIds),4000),evidence:ev(s.evidenceIds)}));
 const variables=p.nodes.filter(n=>n.kind==='variable').map(n=>{const f=(id:string)=>programText(n.fields.find(f=>f.id===id)?.value);return {id:n.id,name:n.title,role:preview(f('role'),500),type:preview(f('type'),500),unit:preview(f('observation-unit')||f('unit'),500),producedBy:preview(names(p.relations.filter(r=>r.to===n.id&&r.type==='produces').map(r=>r.from)),2000),usedBy:preview(names(p.relations.filter(r=>r.from===n.id&&r.type==='uses').map(r=>r.to)),2000),definition:preview(n.description??'',8000),status:n.fields.some(f=>f.state==='missing'||f.state==='decision')?'unresolved' as const:'implementation' as const,entity:n.id};});
 return {id:p.id,title:p.title,source:p.source,program:p,entities,procedure,variables,relations:[...p.relations.map(r=>({from:r.from,to:r.to,label:r.label??r.type})),...p.steps.flatMap(s=>[...s.next.map(e=>({from:`flow:${s.id}`,to:`flow:${e.to}`,label:preview(e.when??'next',300)})),...s.children.map(to=>({from:`flow:${s.id}`,to:`flow:${to}`,label:s.kind}))])],reviewIssues:p.issues.map(i=>({id:i.id,title:i.title,severity:i.severity,reason:preview(i.reason,4000),impact:preview(i.impact,4000),suggestedAction:preview(i.suggestedAction,4000),...(i.nodeId?{entity:i.nodeId}:i.stepId?{entity:`flow:${i.stepId}`}:{}) ,...(i.studyId?{study:i.studyId}:{}),...(i.fieldId?{field:i.fieldId}:{}),evidence:ev(i.evidenceIds)}))};
}

/** A loss-preserving import, not a scientific re-extraction. Missing scope and
 * flow rules stay unknown; the agent must resolve them using actual resources. */
export function importLegacyModel(model:StudySchema):HumanProgram {
 const evidence:ProgramEvidence[]=[],studies=[{id:'imported-study',title:model.title,type:'unspecified' as const}];
 const refs=(e:Evidence,id:string)=>{if(!e.quote&&!e.sourceId)return [];evidence.push({id,...(e.sourceId?{sourceId:e.sourceId}:{path:model.source.filename||'legacy-model'}),locator:{page:e.page,...(e.rects.length?{region:JSON.stringify(e.rects)}:{})},quote:e.quote});return [id];};
 const nodes:ProgramNode[]=model.entities.map(n=>({id:n.id,kind:n.kind,title:n.title,summary:n.subtitle,description:n.description,studyIds:[],evidenceIds:refs(n.evidence,`e:${n.id}`),fields:n.fields.map((f,i)=>({id:f.id??`field-${i+1}`,label:f.name,value:f.value,origin:f.status==='reported'?'reported':f.status==='implementation'?'implementation':'unknown',state:f.status==='unresolved'?'decision':'check',evidenceIds:[],extensions:{legacyStatus:f.status??'unspecified'}}))}));
 const steps:ProgramStep[]=model.procedure.map((s,i)=>({id:s.id,studyId:'imported-study',kind:'action',title:s.name,actorIds:[],inputIds:[],outputIds:[],visibleIds:[],children:[],next:i+1<model.procedure.length?[{to:model.procedure[i+1].id}]:[],evidenceIds:refs(s.evidence,`step-e:${s.id}`),extensions:{legacyInput:s.input,legacyActor:s.actor,legacyOutput:s.output}}));
 const issues:HumanProgram['issues']=(model.reviewIssues??[]).map(i=>({id:i.id,title:i.title,severity:i.severity,reason:i.reason,impact:i.impact,suggestedAction:i.suggestedAction,...(i.entity?{nodeId:i.entity}:{}),evidenceIds:i.evidence?refs(i.evidence,`issue-e:${i.id}`):[]}));
 for(const [ni,n] of nodes.entries())for(const [fi,f] of n.fields.entries())if(f.state==='decision'&&!issues.some(i=>i.nodeId===n.id&&!i.fieldId))issues.push({id:`legacy-review-${ni+1}-${fi+1}`,title:f.label,severity:'check',reason:programText(f.value),impact:'',suggestedAction:'',nodeId:n.id,fieldId:f.id,evidenceIds:[]});
 return validateHumanProgram({schemaVersion:2,id:model.id,title:model.title,intent:'reconstruct',source:model.source,studies,nodes,steps,relations:model.relations.map((r,i)=>({id:`relation-${i+1}`,from:r.from,to:r.to,type:'legacy',label:r.label})),evidence,issues,extensions:{importedFrom:'StudioStudySchema-v1',scopeUnresolved:true,legacyVariables:model.variables as unknown as JsonValue}});
}
