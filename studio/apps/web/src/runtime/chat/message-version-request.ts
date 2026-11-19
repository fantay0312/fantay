import type { ChatMessageBranchRequest } from '@open-design/contracts';
import type { ChatMessage } from '../../types';
import { isFormAnswersMessage } from '../../artifacts/question-form';
import { isDesignSystemWorkspacePrompt } from '../../design-system-auto-prompt';
import { assistantMessageNeverHadARun } from './host-authored-message';

export function messageVersionRequest(current: ChatMessage[], messageId: string, editedText?: string) {
  const index = current.findIndex(message => message.id === messageId);
  const target = current[index];
  const expectedLeafId = current.at(-1)?.id;
  if (!target || !expectedLeafId) return null;
  const action = editedText === undefined ? 'regenerate' : 'edit';
  if (action === 'regenerate' && (
    target.role !== 'assistant' || assistantMessageNeverHadARun(target)
  )) return null;
  let questionIndex = index;
  if (action === 'regenerate') {
    while (questionIndex >= 0 && current[questionIndex]?.role !== 'user') questionIndex--;
  }
  const question = current[questionIndex];
  if (!question || question.role !== 'user' || question.sendFailed
    || isFormAnswersMessage(question.content)
    || isDesignSystemWorkspacePrompt(question.content)) return null;
  if (action === 'regenerate') {
    const taskId = target.strategyTaskExecutionId;
    let settled = target;
    if (taskId) {
      for (let next = index + 1; next < current.length; next++) {
        const successor = current[next]!;
        if (successor.role !== 'assistant' || successor.strategyTaskExecutionId !== taskId
          || (successor.strategyTaskRunIndex ?? 0) === 0) break;
        settled = successor;
      }
    }
    if (settled.runStatus !== undefined && settled.runStatus !== 'succeeded') return null;
  }
  const text = editedText?.trim() ?? question.content;
  if (action === 'edit' && text === question.content.trim()) return null;
  // One visible logical reply can contain several physical runs. Branch
  // from the first assistant row after its question to keep the whole old turn.
  const branchTarget = action === 'edit' ? question : current[questionIndex + 1];
  if (!branchTarget || (action === 'regenerate' && branchTarget.role !== 'assistant')) return null;
  const branch: ChatMessageBranchRequest = { action, messageId: branchTarget.id, expectedLeafId };
  return { branch, question, questionIndex, text };
}
