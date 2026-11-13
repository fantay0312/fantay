type EnvMap = NodeJS.ProcessEnv | Record<string, string | undefined>;

export const TOKENTOSEA_CONSOLE_ORIGIN = 'https://tokentosea.com';
/** Kept for import compatibility; upstream profile URLs are never used. */
export const DEFAULT_VELA_CONSOLE_ORIGIN = TOKENTOSEA_CONSOLE_ORIGIN;
export function resolveEffectiveVelaConsoleOrigin(_env: EnvMap = process.env, _configuredEnv: EnvMap = {}): string {
  return TOKENTOSEA_CONSOLE_ORIGIN;
}
