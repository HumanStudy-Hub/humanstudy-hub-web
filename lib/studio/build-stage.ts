import type { StudioDocument } from './types';

/** First extraction has an intake and processing view. Later builds keep the editor open. */
export function workspaceBuildStage(document: StudioDocument): 'intake' | 'processing' | 'editor' {
  if (document.model.entities.length || document.model.program?.nodes.length || document.model.program?.steps.length) return 'editor';
  const initialResult = document.conversations.flatMap(c => c.messages).some(m =>
    m.proposal && m.proposal.id === document.pipeline?.proposalId);
  if (initialResult) return 'editor';
  return document.pipeline ? 'processing' : 'intake';
}

export function firstBuildPreview(document?: StudioDocument): string | undefined {
  if (!document || document.model.entities.length || document.model.program?.nodes.length || document.model.program?.steps.length) return;
  return document.conversations.flatMap(c => c.messages).find(m =>
    m.proposal?.id === document.pipeline?.proposalId && m.proposal?.status === 'pending')?.proposal?.id;
}
