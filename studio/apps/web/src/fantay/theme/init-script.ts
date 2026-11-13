/* SPDX-License-Identifier: AGPL-3.0-only */
/** Must equal THEME_STORAGE_KEY in @fantay/tokens (asserted by tests/fantay/theme.test.ts). */
export const FANTAY_THEME_STORAGE_KEY = 'fantay:theme';

/**
 * Runs in <head> before hydration (app/layout.tsx). Stamps data-theme OUTSIDE any try so a throwing
 * storage read still leaves the attribute present. Accent: only a non-default custom accent is written
 * inline; the default (#353535) follows the theme via --accent → var(--ink) (legacy-aliases.css).
 * Keep the colour-mix ratios in sync with accentVars() in src/state/appearance.ts.
 */
export const FANTAY_THEME_INIT_SCRIPT = `(function(){var d=document.documentElement,t='light',p=null;try{p=window.localStorage.getItem('fantay:theme');}catch(e){}if(p==='dark'){t='dark';}d.setAttribute('data-theme',t);d.style.colorScheme=t;try{var c=JSON.parse(window.localStorage.getItem('open-design:config')||'{}');var a=typeof c.accentColor==='string'&&/^#[0-9a-fA-F]{6}$/.test(c.accentColor.trim())?c.accentColor.trim().toLowerCase():'';if(c.configMigrationVersion!==3&&(a==='#87ea5c'||a==='#c96442'))a='';if(a&&a!=='#353535'){var s=d.style;s.setProperty('--accent',a);s.setProperty('--accent-strong','color-mix(in srgb, '+a+' 82%, var(--text-strong))');s.setProperty('--accent-soft','color-mix(in srgb, '+a+' 12%, var(--bg-subtle))');s.setProperty('--accent-tint','color-mix(in srgb, '+a+' 6%, var(--bg-panel))');s.setProperty('--accent-hover','color-mix(in srgb, '+a+' 86%, var(--text-strong))');}}catch(e){}})();`;
