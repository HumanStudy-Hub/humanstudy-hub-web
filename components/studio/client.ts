import type { StudioDocument } from "@/lib/studio/types";

const messages:Record<string,string>={
 project_copy_failed:'The project was saved, but its file copy failed. Open Projects and choose Retry file copy.',
 project_copy_pending:'Finish copying the project files before continuing. Open Projects to retry.',
 project_copy_too_large:'This project exceeds the 50 MB fork file limit. Export it to keep a complete copy.',
 discussion_busy:'The agent is answering your previous message. Your draft is saved.',
 discussion_not_found:'Could not retrieve this response. Retry the message after the failed launch.',
 proposal_stale_model:'The study changed after this proposal was made. Continue discussing it to get an updated proposal, or set it aside.',
 proposal_version_missing:'This older proposal needs to be refreshed. Continue discussing it with the agent.',

 pipeline_setup_required:'The original Build Study pipeline is not connected on this deployment. Configure GitHub access and its workflow branch.',
 pipeline_busy:'The study-building agent is running. Keep your feedback here and send it when the build finishes.',
 paper_required:'Upload a PDF before starting the study-building agent.',
 resources_too_large:'Attached resources, including supplementary PDFs, exceed the 20 MB combined build limit.',
 resource_unavailable:'An attached resource could not be read from private storage. Re-upload it, then try again.',
 resource_upload_failed:'The resource bundle could not be saved for the build. Please retry.',
 invalid_source:'This source has invalid metadata or is unavailable. Re-upload it before building.',
 pipeline_not_found:'Could not retrieve this study build. Check GitHub access or send the request again after a failed launch.',
 package_preview_too_large:'This package is too large for the visual preview. Export the original package instead.',
 setup_required:'The workspace service is not configured yet.',
 agent_setup_required:'The AI provider is not configured yet. Your draft is saved; add the server key and model to enable chat.',
 unauthorized:'Your session expired. Save a local draft, then sign in again.',
 authentication_failed:'Could not sign in. Check your email, password and email confirmation.',
 email_not_confirmed:'Confirm your email first. You can resend the confirmation below.',
 confirmation_expired:'This confirmation link has expired or was already used. Sign in, or request another email.',
 invalid_confirmation:'This confirmation link is invalid. Request another email from the sign-in page.',
 email_delivery_setup_required:'Registration email is not available for this address yet. The site needs its email delivery service configured.',
 email_service_unavailable:'The email service is temporarily unavailable. Please retry later.',
 auth_redirect_setup_required:'The registration return address is not configured correctly.',
 rate_limited:'Too many attempts. Please wait a moment before trying again.',
 revision_conflict:'This study changed in another session. Download your local draft before loading the latest version.',
 proposal_breaks_references:'This change removes an object linked to an annotation. Ask the agent to preserve that object or unlink its annotation first.',
 proposal_already_decided:'This proposal was already reviewed.',
 invalid_agent_artifacts:'The agent returned invalid material files. Your saved materials are unchanged; please retry.',
 model_too_large_for_agent:'This model is too large for a single chat request. Export it for your local agent.',
 artifacts_too_large_for_agent:'The material bundle is too large for a single chat request. Export it for your local agent.',
 invalid_agent_model:'The agent returned an invalid study model. Your current model is unchanged; please retry.',
 invalid_agent_citation:'A proposed quote could not be verified against the source. Please retry with the relevant passage selected.',
 invalid_agent_response:'The agent returned an unreadable response. Please try again.',
 agent_unavailable:'The AI provider did not complete the request. Your message remains in the composer.',
 invalid_document:'This change could not be saved because it contains an invalid reference or exceeds a workspace limit. Export your local draft before reloading.',
 body_too_large:'The workspace has reached the document size limit. Export a local draft before continuing.',
 service_unavailable:'The workspace service is temporarily unavailable. Please retry.',
};
export class StudioApiError extends Error {
 constructor(public status:number,public body:Record<string,unknown>){super(typeof body.message==='string'?body.message:typeof body.error==='string'?(messages[body.error]||body.error):'Request failed');}
}
export async function studioApi<T>(path:string,init?:RequestInit):Promise<T>{
 const response=await fetch(path,{...init,credentials:'same-origin',cache:'no-store',headers:{...(init?.body?{'Content-Type':'application/json'}:{}),...init?.headers}});
 const body=await response.json().catch(()=>({error:'Invalid server response'}));
 if(!response.ok)throw new StudioApiError(response.status,body);
 return body as T;
}

// These snapshots are owned by the server and restored by PATCH. Sending them
// again on every keystroke makes a long study history consume the save budget.
export function studioAutosaveDocument(document:StudioDocument):StudioDocument {
 const {programVersions,...editable}=document;void programVersions;
 return {...editable,conversations:editable.conversations.map(c=>({...c,messages:c.messages.map(({proposal,...message})=>{void proposal;return message;})}))};
}
