import type { SideDialogueSnapshot } from '@open-design/contracts';
import type { ChatMessage } from '../../types';

export function dialogueSnapshot(title: string, running: boolean, queued: number, messages: ChatMessage[]): SideDialogueSnapshot {
  return {
    title: title.slice(0, 500), status: running ? 'running' : 'idle', queued,
    recent: messages.slice(-8).map(message => {
      const events = message.events ?? [];
      const publicText = message.content || events.flatMap(event => event.kind === 'text' ? [event.text] : []).join('');
      const activity = events.flatMap(event => {
        if (event.kind === 'tool_use') return [event.name];
        if (event.kind === 'status') return [[event.label, event.detail].filter(Boolean).join(' · ')];
        if (event.kind === 'tool_result') return [event.isError ? 'Tool returned an error' : 'Tool call finished'];
        return [];
      });
      const text = publicText.length <= 2400 ? publicText : publicText.slice(0, 800) + '\n…\n' + publicText.slice(-1597);
      return { role: message.role, text, status: message.runStatus, activity: activity.slice(-5).map(item => item.slice(0, 250)) };
    }),
  };
}
