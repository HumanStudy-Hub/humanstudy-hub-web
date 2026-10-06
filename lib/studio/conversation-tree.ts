import type { StudioConversation, StudioMessage, StudioMessageRef } from "./types";

export type ConversationContextItem = { conversationId: string; message: StudioMessage };

/** Verify every link before saving; older flat conversations remain valid. */
export function assertConversationTree(conversations: readonly StudioConversation[]): void {
  const byId = new Map(conversations.map(conversation => [conversation.id, conversation]));
  const exists = (ref: StudioMessageRef) => byId.get(ref.conversationId)?.messages.some(message => message.id === ref.messageId) ?? false;
  for (const conversation of conversations) {
    if (conversation.parent && !exists(conversation.parent)) throw new Error("Conversation parent refers to a missing message.");
    for (const message of conversation.messages) {
      if (message.replyTo && !exists(message.replyTo)) throw new Error("Message replyTo refers to a missing message.");
      if (message.mergedFrom && !exists(message.mergedFrom)) throw new Error("Message mergedFrom refers to a missing message.");
    }
  }
  const checked = new Set<string>();
  const visiting = new Set<string>();
  const visit = (conversation: StudioConversation) => {
    if (visiting.has(conversation.id)) throw new Error("Conversation parent links contain a cycle.");
    if (checked.has(conversation.id)) return;
    visiting.add(conversation.id);
    if (conversation.parent) visit(byId.get(conversation.parent.conversationId)!);
    visiting.delete(conversation.id);
    checked.add(conversation.id);
  };
  for (const conversation of conversations) visit(conversation);
}

/** Ancestors stop at their fork messages; sibling and later parent turns stay out. */
export function resolveConversationContext(conversations: readonly StudioConversation[], conversationId: string, throughMessageId?: string): ConversationContextItem[] {
  assertConversationTree(conversations);
  const byId = new Map(conversations.map(conversation => [conversation.id, conversation]));
  const resolve = (id: string, through?: string): ConversationContextItem[] => {
    const conversation = byId.get(id);
    if (!conversation) throw new Error("Conversation is missing.");
    const end = through === undefined ? conversation.messages.length : conversation.messages.findIndex(message => message.id === through) + 1;
    if (end === 0) throw new Error("Conversation message is missing.");
    const ancestors = conversation.parent ? resolve(conversation.parent.conversationId, conversation.parent.messageId) : [];
    return [...ancestors, ...conversation.messages.slice(0, end).map(message => ({ conversationId: id, message }))];
  };
  return resolve(conversationId, throughMessageId);
}

/** A safe prompt snapshot containing only this branch and its truncated ancestors. */
export function scopeConversationsForPrompt(conversations: readonly StudioConversation[], conversationId: string): StudioConversation[] {
  assertConversationTree(conversations);
  const byId = new Map(conversations.map(conversation => [conversation.id, conversation]));
  const scope = (id: string, through?: string): StudioConversation[] => {
    const conversation = byId.get(id);
    if (!conversation) throw new Error("Conversation is missing.");
    const end = through === undefined ? conversation.messages.length : conversation.messages.findIndex(message => message.id === through) + 1;
    if (end === 0) throw new Error("Conversation message is missing.");
    const ancestors = conversation.parent ? scope(conversation.parent.conversationId, conversation.parent.messageId) : [];
    return [...ancestors, { ...conversation, messages: conversation.messages.slice(0, end) }];
  };
  return scope(conversationId);
}
