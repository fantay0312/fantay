import vm from "node:vm";

const sandbox: { source: string; flags: string; text: string } = { source: "", flags: "", text: "" };
const context = vm.createContext(sandbox);
const script = new vm.Script("new RegExp(source, flags).test(text)");
const timedOut = new Set<string>();
const KEY_TIMEOUT_MS = 25;
/** Total time one prompt build (or one lorebook test) may spend on unsafe world-book regexes. */
export const PA_LORE_REGEX_BUDGET_MS = 200;

/**
 * Runs an unsafe world-book regex with a 25 ms budget. `null` means "timed out"; a key that used its full 25 ms is
 * not tried again. A shorter `timeoutMs` (the tail of a call budget) answers `null` without remembering the key.
 */
export function paLoreRegexTest(source: string, flags: string, text: string, timeoutMs = KEY_TIMEOUT_MS): boolean | null {
  const key = `${flags}/${source}`;
  if (timedOut.has(key)) return null;
  sandbox.source = source;
  sandbox.flags = flags;
  sandbox.text = text;
  try {
    return script.runInContext(context, { timeout: Math.max(1, Math.ceil(timeoutMs)) }) === true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
      if (timeoutMs >= KEY_TIMEOUT_MS) timedOut.add(key);
      return null;
    }
    return false;
  }
}

/**
 * One regex tester per prompt build: every unsafe key shares `totalMs`, and once it is spent the remaining keys answer
 * `null` (counted as regex-timeout) without running, so a hostile book cannot block the event loop for longer than
 * that per turn. Results are remembered for the build, so the argv-shrinking recompositions cost nothing extra.
 */
export function paLoreRegexBudget(totalMs = PA_LORE_REGEX_BUDGET_MS): (source: string, flags: string, text: string) => boolean | null {
  let spent = 0;
  const seen = new Map<string, boolean | null>();
  return (source, flags, text) => {
    const key = `${flags}/${source}\u0000${text}`;
    const known = seen.get(key);
    if (known !== undefined) return known;
    if (spent >= totalMs) return null;
    const started = performance.now();
    const result = paLoreRegexTest(source, flags, text, Math.min(KEY_TIMEOUT_MS, totalMs - spent));
    spent += performance.now() - started;
    seen.set(key, result);
    return result;
  };
}
