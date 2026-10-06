import { importLegacyModel, humanProgramContract } from "@/lib/studio/human-program";
import { listPackageFiles, readOwnedStudioJob } from "@/lib/github-jobs";
import { modelFingerprint } from "@/lib/studio/model-version";
import JSZip from "jszip";
import { requireStudioUser } from "@/lib/studio/auth";
import { routeError, studioFetch, StudioError } from "@/lib/studio/http";
import { getWorkspace } from "@/lib/studio/store";
import { validateStudioDocument } from "@/lib/studio/validation";
import { sourceSpec, validStoredSource } from "@/lib/studio/resources";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;

async function readSourceBytes(response: Response, maximum: number): Promise<Uint8Array> {
  const length = response.headers.get("content-length");
  if (length && Number(length) > maximum) throw new Error("Source exceeds export limit");
  if (!response.body) throw new Error("Source has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error("Source exceeds export limit");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function GET(_request: Request, { params }: Context) {
  try {
    const ctx = await requireStudioUser();
    const { id } = await params;
    const workspace = await getWorkspace(ctx, id);
    if (!workspace) throw new StudioError(404, "not_found");
    const document = validateStudioDocument(workspace.document);
    const zip = new JSZip();
    const json = (name: string, value: unknown) => zip.file(name, JSON.stringify(value, null, 2));
    json("document.json", document);
    json("model.json", document.model);
    json("human-program.json", document.model.program??importLegacyModel(document.model));
    json("human-program.schema.json",humanProgramContract);
    json("conversations.json", document.conversations);
    json("annotations.json", document.annotations);
    json("reviews.json", document.reviewResponses);
    json("sources.json", document.sources.map(source => ({ ...source, text: undefined, pages: undefined })));
    json("artifacts.json", document.artifacts || []);
    const auxiliaryMaterials = (document.artifacts || []).map(artifact => {
      const archivePath = `materials/${artifact.id}/${artifact.filename}`;
      zip.file(archivePath, artifact.content);
      return { id: artifact.id, title: artifact.title, kind: artifact.kind, format: artifact.format, sourceIds: artifact.sourceIds, archivePath };
    });
    const fileManifest: Array<{ sourceId: string; originalName: string; archivePath?: string; reason?: string }> = [];
    let totalSourceBytes = 0;
    for (const source of document.sources) {
      const item: { sourceId: string; originalName: string; archivePath?: string; reason?: string } = { sourceId: source.id, originalName: source.name };
      const spec = sourceSpec(source.name);
      if (!spec || !validStoredSource(source, ctx.user.id, id)) {
        item.reason = "The source has no verified private storage path.";
      } else if (source.size + totalSourceBytes > MAX_SOURCE_BYTES) {
        item.reason = "Including this source would exceed the 50 MB export source limit.";
      } else {
        try {
          const path = source.path.split("/").map(encodeURIComponent).join("/");
          const response = await studioFetch(`/storage/v1/object/authenticated/studio-sources/${path}`, { token: ctx.accessToken });
          if (!response.ok) throw new Error("Source unavailable");
          const bytes = await readSourceBytes(response, Math.min(source.size + 1024, MAX_SOURCE_BYTES - totalSourceBytes));
          item.archivePath = `source-files/${source.id}.${spec.extension}`;
          zip.file(item.archivePath, bytes);
          totalSourceBytes += bytes.byteLength;
        } catch {
          item.reason = "The private source file could not be included; its reference remains in document.json.";
        }
      }
      fileManifest.push(item);
    }
    let buildPackage: {jobId?:string;status?:string;files?:string[];reason?:string;modelFingerprint?:string;currentModelFingerprint:string}|undefined;
    const currentModelFingerprint=modelFingerprint(document.model);
    if(document.pipeline||document.acceptedPackage){
      buildPackage={jobId:document.acceptedPackage?.jobId,status:document.pipeline?.status,currentModelFingerprint,modelFingerprint:document.acceptedPackage?.modelFingerprint};
      if(!document.acceptedPackage)buildPackage.reason='No package has been accepted for this model.';
      else if(document.acceptedPackage.modelFingerprint!==currentModelFingerprint)buildPackage.reason='The accepted package is for an older model revision. Sync the package before using it.';
      else {
      try{
        const job=await readOwnedStudioJob(document.acceptedPackage.jobId,{ownerId:ctx.user.id,workspaceId:id});buildPackage.status=job.status;
        if((job.status==='review'||job.status==='complete')&&job.packageReady===true){
          const files=await listPackageFiles(job.id,{ownerId:ctx.user.id,workspaceId:id});
          if(files.reduce((n,file)=>n+file.content.length,0)>40*1024*1024)throw new Error('Package exceeds export limit');
          for(const file of files){
            if(!file.path.split('/').every(part=>part&&part!=='.'&&part!=='..')||file.path.includes('\\'))throw new Error('Invalid package path');
          }
          buildPackage.files=files.map(file=>`build-package/${file.path}`);
          files.forEach(file=>zip.file(`build-package/${file.path}`,file.content));
        }else buildPackage.reason='The accepted package is not ready yet.';
      }catch{buildPackage.reason='The accepted package could not be retrieved; workspace data remains included.';}
      }
    }
    const unresolved = [
      ...document.model.entities.flatMap(entity => entity.fields.filter(field => field.status === "unresolved").map(field => `${entity.title}: ${field.name} — ${field.value}`)),
      ...document.model.variables.filter(variable => variable.status === "unresolved").map(variable => `${variable.name}: ${variable.definition}`),
    ];
    const pendingProposals = document.conversations.flatMap(conversation => conversation.messages.filter(message => message.proposal?.status === "pending").map(message => ({ conversationId: conversation.id, proposalId: message.proposal!.id, summary: message.proposal!.summary })));
    const sourceReferences = [
      ...document.model.entities.map(entity => ({ objectId: entity.id, sourceId: entity.evidence.sourceId, page: entity.evidence.page, quote: entity.evidence.quote })),
      ...document.model.procedure.map(step => ({ objectId: step.id, sourceId: step.evidence.sourceId, page: step.evidence.page, quote: step.evidence.quote })),
    ];
    json("manifest.json", { format: "humanstudy-studio-export", version: 1, program: {schemaVersion:2,file:"human-program.json",contract:"human-program.schema.json",imported:!document.model.program}, exportedAt: new Date().toISOString(), workspaceId: id, revision: workspace.revision, sourceFiles: fileManifest, buildPackage, auxiliaryMaterials, pendingProposals, unresolved, sourceReferences, executable: false });
    zip.file("HANDOFF.md", [
      `# ${document.title}`,
      "",
      `Workspace: ${id} · revision ${workspace.revision}`,
      "",
      "This handoff contains the workspace and, when available, the original agent package under build-package/. Check manifest.json for its build/review status and any omissions. Review unresolved design decisions before execution.",
      "",
      "## Open decisions",
      ...(unresolved.length ? unresolved.map(item => `- ${item}`) : ["- No fields are marked unresolved; verify the protocol and source evidence before execution."]),
      "",
      "## Pending model proposals",
      ...(pendingProposals.length ? pendingProposals.map(item => `- ${item.proposalId}: ${item.summary}`) : ["- None"]),
      "",
      "## Auxiliary materials",
      ...(auxiliaryMaterials.length ? auxiliaryMaterials.map(item => `- ${item.title} (${item.archivePath})`) : ["- None"]),
      "",
      "The complete model, conversations, annotations, review responses, auxiliary materials and source references are in the JSON files. Generated scripts are drafts and have not been executed. Source files are included when accessible from the authenticated private bucket; check manifest.json for any omissions.",
      "",
    ].join("\n"));
    const archive = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
    const bytes = new Uint8Array(archive.length);
    bytes.set(archive);
    return new Response(bytes.buffer, { status: 200, headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="studio-${id}-r${workspace.revision}.zip"`, "Cache-Control": "private, no-store" } });
  } catch (error) { return routeError(error); }
}
