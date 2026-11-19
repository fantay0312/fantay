// SPDX-License-Identifier: AGPL-3.0-only
// "查看源码" from a syntax error opens the source with the broken line in the middle, selected and
// focused.
// The shared source pane (`parts/CodePane`) has no "go to line" input, so this finds the CodeMirror
// view it mounted (through CodeMirror's public `EditorView.findFromDOM`) once it is ready and
// moves its selection there. If the editor never appears, nothing happens: the source still shows.

const WAIT_MS = 4000;

/**
 * Selects line `line` (1-based) of the code pane inside `host` and scrolls it to the centre, then
 * calls `onDone`. Returns a function that cancels a reveal still waiting for the editor.
 */
export function revealSourceLine(host: HTMLElement, line: number, onDone: () => void): () => void {
  let cancelled = false;
  let frame = 0;
  const started = performance.now();

  const attempt = async (): Promise<void> => {
    if (cancelled) return;
    const editor = host.querySelector<HTMLElement>('.cm-editor');
    if (editor) {
      const { EditorView } = await import('@codemirror/view');
      if (cancelled) return;
      const view = EditorView.findFromDOM(editor);
      // The text arrives after the view is created; wait until the line exists.
      if (view && view.state.doc.lines >= Math.min(line, 2) && view.state.doc.length > 0) {
        const target = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines));
        view.dispatch({
          selection: { anchor: target.from, head: target.to },
          effects: EditorView.scrollIntoView(target.from, { y: 'center' }),
        });
        // The read-only pane draws its selection only while focused; focus also puts a keyboard
        // reader on the line that was asked for.
        view.focus();
        onDone();
        return;
      }
    }
    if (performance.now() - started < WAIT_MS) frame = window.requestAnimationFrame(() => void attempt());
    else onDone();
  };

  frame = window.requestAnimationFrame(() => void attempt());
  return () => {
    cancelled = true;
    window.cancelAnimationFrame(frame);
  };
}
