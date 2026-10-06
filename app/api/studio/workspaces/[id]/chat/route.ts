import { NextResponse } from "next/server";
import { requireStudioUser } from "@/lib/studio/auth";
import { startPipeline } from "@/lib/studio/pipeline";
import { assertSameOrigin, isUuid, readJsonBody, routeError, StudioError } from "@/lib/studio/http";
import { getWorkspace } from "@/lib/studio/store";
import { validateModelAnchor, validateSourceSelection, validateStudioDocument, validateStudioMessageRef } from "@/lib/studio/validation";

export const runtime = "nodejs";
export const maxDuration = 60;

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  try {
    assertSameOrigin(request);
    const ctx = await requireStudioUser();
    const { id } = await params;
    const body = await readJsonBody(request, 64_000) as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new StudioError(400, "invalid_request");
    const { conversationId, requestId, revision } = body;
    if (!isUuid(conversationId) || !isUuid(requestId)) throw new StudioError(400, "invalid_request_id");
    if (!Number.isSafeInteger(revision) || (revision as number) < 1) throw new StudioError(400, "invalid_revision");
    if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 12000) throw new StudioError(400, "invalid_message");
    const workspace = await getWorkspace(ctx, id);
    if (!workspace) throw new StudioError(404, "not_found");
    const document = validateStudioDocument(workspace.document);
    const previous = document.conversations.flatMap(c => c.messages).find(message => message.id === requestId);
    if (previous) {
      const conversation = document.conversations.find(c => c.messages.includes(previous));
      const index = conversation?.messages.indexOf(previous) ?? -1;
      return NextResponse.json({ workspace, message: conversation?.messages[index + 1] || null, idempotent: true });
    }
    if (workspace.revision !== revision) return NextResponse.json({ error: "revision_conflict", latest: workspace }, { status: 409 });
    const modelAnchor = validateModelAnchor(body.modelAnchor, document.model);
    const sourceSelection = validateSourceSelection(body.sourceSelection, document.sources);
    const parent = validateStudioMessageRef(body.parent, "conversation.parent");
    const replyTo = validateStudioMessageRef(body.replyTo, "message.replyTo");
    const mergedFrom = validateStudioMessageRef(body.mergedFrom, "message.mergedFrom");
    const existingConversation = document.conversations.find(conversation => conversation.id === conversationId);
    if (parent && (existingConversation ? JSON.stringify(existingConversation.parent) !== JSON.stringify(parent) : !document.conversations.some(conversation => conversation.id === parent.conversationId && conversation.messages.some(message => message.id === parent.messageId)))) {
      throw new StudioError(400, "invalid_conversation_parent");
    }
    for (const ref of [replyTo, mergedFrom]) if (ref && !document.conversations.some(conversation => conversation.id === ref.conversationId && conversation.messages.some(message => message.id === ref.messageId))) throw new StudioError(400, "invalid_message_reference");
    if(body.sourceId!==undefined&&(!isUuid(body.sourceId)||!document.sources.some(source=>source.id===body.sourceId)))throw new StudioError(400,"invalid_source");
    const saved = await startPipeline(ctx, workspace, {sourceId:body.sourceId as string|undefined,conversationId,requestId,text:body.text.trim(),modelAnchor,sourceSelection,parent,replyTo,mergedFrom});
    return NextResponse.json({workspace:saved}, {status:202});
  } catch (error) { return routeError(error); }
}
