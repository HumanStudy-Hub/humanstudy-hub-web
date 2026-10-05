import { NextResponse } from "next/server";
import { requireStudioUser } from "@/lib/studio/auth";
import { generateStudyReply } from "@/lib/studio/agent";
import { assertSameOrigin, isUuid, readJsonBody, routeError, StudioError } from "@/lib/studio/http";
import { getWorkspace, saveWorkspace } from "@/lib/studio/store";
import { validateModelAnchor, validateSourceSelection, validateStudioDocument } from "@/lib/studio/validation";
import type { StudioConversation, StudioMessage } from "@/lib/studio/types";

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
    const now = new Date().toISOString();
    const text = body.text.trim();
    const answer = await generateStudyReply(document, conversationId, text, modelAnchor, sourceSelection);
    const userMessage: StudioMessage = { id: requestId, role: "user", text, createdAt: now,
      ...(modelAnchor ? { modelAnchor } : {}), ...(sourceSelection ? { sourceSelection } : {}),
      ...(modelAnchor?.entityIds[0] ? { entityId: modelAnchor.entityIds[0] } : {}) };
    const hasProposal = answer.model !== undefined || answer.artifacts !== undefined;
    const agentMessage: StudioMessage = { id: crypto.randomUUID(), role: "agent", text: answer.reply, createdAt: new Date().toISOString(),
      ...(hasProposal ? { proposal: { id: crypto.randomUUID(), model: answer.model || document.model,
        changesModel: answer.model !== undefined, ...(answer.artifacts !== undefined ? { artifacts: answer.artifacts } : {}), summary: answer.reply.slice(0, 4000), status: "pending" as const } } : {}) };
    const existing = document.conversations.find(c => c.id === conversationId);
    if (existing && existing.messages.length > 998) throw new StudioError(413, "conversation_too_large");
    const selected = modelAnchor?.entityIds[0] || existing?.selected || document.model.entities[0]?.id || "";
    const conversation: StudioConversation = existing
      ? { ...existing, messages: [...existing.messages, userMessage, agentMessage], updatedAt: now, modelAnchor, sourceSelection, selected,
          title: existing.title || text.slice(0, 80) }
      : { id: conversationId, title: text.slice(0, 80), updatedAt: now, messages: [userMessage, agentMessage], draft: "", modelAnchor, sourceSelection, selected };
    const updated = validateStudioDocument({ ...document, conversations: [...document.conversations.filter(c => c.id !== conversationId), conversation], activeConversationId: conversationId });
    const saved = await saveWorkspace(ctx, id, updated, revision as number);
    if ("conflict" in saved) {
      const alreadySaved = saved.latest?.document.conversations.some(c => c.messages.some(message => message.id === requestId));
      if (alreadySaved) return NextResponse.json({ workspace: saved.latest, idempotent: true });
      return NextResponse.json({ error: "revision_conflict", latest: saved.latest }, { status: 409 });
    }
    return NextResponse.json({ workspace: saved, message: agentMessage });
  } catch (error) { return routeError(error); }
}
