// Shared helper for the marketing "Workspace for Teams" landing page URL.
// Used by both the Home toolbar chip (EntryShell) and the compact settings
// menu (EntrySettingsMenu) so the narrow-screen entry stays in sync with the
// wide one. Opens in the external browser. The marketing site lives
// outside this repo, so both development and production use the
// deployed origin.
export function enterpriseUrl(_locale: string): string {
  return 'https://design.tokentosea.com/feedback/';
}
