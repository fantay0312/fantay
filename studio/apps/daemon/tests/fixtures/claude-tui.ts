// Deterministic native-terminal fixture: no network or provider credentials.
import fs from 'node:fs';
import path from 'node:path';
const argv = process.argv.slice(2);
const at = argv.findIndex((a) => a === '--session-id' || a === '--resume');
const id = argv[at + 1]!;
const dir = path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${id}.jsonl`);
const append = (row: unknown) => fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR!, 'launch.json'), JSON.stringify({
  argv, isTTY: !!process.stdin.isTTY, entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? null,
}));
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write(process.env.FANTAY_TEST_TUI_DIALOG === 'external'
  ? 'Allow external CLAUDE.md file imports?\r\n❯ No, disable external imports\r\n  Yes, allow external imports'
  : '\x1b[32m❯ \x1b[0m');
let buffer = '';
let count = 0;
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  if (!buffer.endsWith('\r')) return;
  const prompt = buffer.replace(/\x1b\[20[01]~/g, '').replace(/\r$/, '');
  buffer = '';
  count++;
  append({ type: 'user', message: { role: 'user', content: prompt } });
  if (prompt.includes('WAIT_PERMISSION')) { process.stdout.write('Do you want to proceed?\n1. Yes\n2. No'); return; }
  if (prompt.includes('HANG')) return;
  append({ type: 'assistant', message: { id: `m${count}`, model: 'fixture', stop_reason: 'end_turn', content: [{ type: 'text', text: process.env.FANTAY_TEST_TUI_NO_ECHO ? 'done' : `reply ${count}: ${prompt}` }] } });
  // A redraw is deliberately emitted BEFORE completion: the adapter must not
  // infer successful completion from terminal pixels or assistant stop_reason.
  process.stdout.write('\x1b[2K\r❯ ');
  setTimeout(() => append({ type: 'system', subtype: 'turn_duration', durationMs: 10 }), 100);
});
