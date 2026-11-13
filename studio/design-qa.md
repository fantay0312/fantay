# Design system studio QA — 2026-10-26

final result: passed

## Catalog v2 follow-up

The subsequent component/pattern/template audit is documented in `docs/design-system-catalog-audit-20261026.md`. The first catalog's save-feedback-only examples were replaced with actual local interactions; 15 entries now include 72 runnable state/variant examples. Three separate temporary entries were edited, saved, reloaded and reused as independent projects, and their test projects were removed afterward. Copy/download includes tokens, local resources and asset licenses.

Current visual evidence is `.tmp/catalog-audit/08-final-catalog.png`, `09-final-editor.png`, `10-mobile-catalog.png`, and `catalog-reference-comparison.png`. The comparison uses the user-supplied component Name/Preview reference (1928 × 1632), normalized to 1100 px wide beside the 1100 × 950 implementation; different framing and starter content are intentional. Desktop and 390 px mobile canvases have no page-level horizontal overflow. The final editor presents usable source-edit height and live preview together.

A development hot-update stylesheet cache anomaly was observed during source editing. Its screenshot was rejected; after a control-plane restart and a clean page load, styles were rechecked, including after a real entry save. Fresh preview console errors: none. The section navigator was also corrected to track sections that remain visible when the preceding section exits, and menu order now matches document order. This has a focused regression test.

Source/demo state, fault handling, asset packaging, stale editor rejection and project-write cleanup have focused tests; repository guard and workspace type checks passed. Demo data remains explicitly local to the browser, independently of the server-backed specification document.

## Scope and visual truth

The owner's Claude Design screenshots define the neutral document canvas, serif section headings, rounded paper panels, section navigation, inline token tables, theme comparison and the five-layer information architecture. The implementation retains Fantay identity and Chinese product content; it does not copy the Mojian brand or claim to duplicate Claude's remote integrations.

Source images:

- `/var/folders/hz/rw0f86hj6p790vsr1vjp4pyw0000gn/T/codex-clipboard-8a1daa8e-e9fb-4ea2-9182-10250a0f1722.png` — 1940 × 5253, original overview reference.
- `/var/folders/hz/rw0f86hj6p790vsr1vjp4pyw0000gn/T/codex-clipboard-9560ddff-4b73-4689-a8bc-a8f0df5574c5.png` — 1928 × 1632, populated theme-table reference.

The overview was normalized to 970 px wide and cropped to its first 900 px. The table reference was normalized to 970 px wide and padded to 900 px high. The table source is a content crop without a full toolbar; the implementation includes the persistent toolbar. Comparisons evaluate the corresponding panel/table regions, not their unmatched browser framing.

## Rendered evidence

- `.tmp/design-system-studio/final-desktop.png` — full-screen overview, CSS viewport and image 970 × 900.
- `.tmp/design-system-studio/final-colors.png` — populated inline tables with light, dark and high-contrast columns, 970 × 900.
- `.tmp/design-system-studio/final-mobile.png` — overview, 390 × 844.
- `.tmp/design-system-studio/final-mobile-table.png` — horizontally scrollable comparison table, 390 × 844.
- `.tmp/design-system-studio/overview-comparison.png` and `colors-comparison.png` — source and implementation viewed together at normalized density.
- `.tmp/design-system-studio/template.png` — independent project created from a template, including its working save feedback.

Root canvas measured `clientWidth === scrollWidth` at both 970 and 390 px. Wide data tables scroll within their own region. No fresh browser console errors were present in the final preview tab.

## Fidelity review

- Typography: classic serif headings with a quiet sans-serif interface, clear heading/body separation. The ordered principle list was enlarged to match body reading size; compact mobile size is retained.
- Layout: gray canvas, white rounded content panels, persistent top controls, section search/navigation, table name/value columns and side-by-side theme values follow the supplied references. Added layers extend the same hierarchy.
- Colors/tokens: neutral workspace chrome remains independent from edited package tokens. Color cells show real values or explicit inheritance. Three themes intentionally extend the two-theme reference.
- Assets: existing Remix icons and real uploaded font files are used. No imitation brand image is inserted. The exported Albert Sans font includes its OFL license.
- Copy/content: Chinese interface with concrete editable principles, explicit draft component status, useful empty states, visible errors, and no invented integration or accessibility-compliance claims.

## Functional evidence

Verified through the live interface and the normal HTTP/CLI surfaces:

- Create an editable system; initialize 8 component drafts, 4 patterns, 3 templates, 3 themes, and 10 unchecked manual review items.
- Edit a color and add spacing; refresh and confirm persisted values.
- Edit a theme override inline; clear it and confirm inheritance is restored.
- Upload token and component files; upload a real font and confirm it is loaded in the specimen.
- Open revision comparison and restore the selected single-source version.
- Create a project from the Settings template, verify its rendered fields and save feedback, and remove the temporary verification projects.
- Compare project and canonical JSON/CSS, verify the agent-facing handbook, and export a ZIP containing source, token adapters, components, documentation, font and license.

Validation records: `final-web.log`, `review-fix-web.log`, `review-fix-daemon.log`, `final-typecheck.log`, `final-guard.log`, `template-fix-test.log`, and `final-data-check.json` in the same evidence directory. Focused tests cover scoped source editing, theme inheritance, alias resolution, document validation, authorization, large revision retention and pending retry journals. Repository guard and full workspace type checks passed.

## Comparison and correction history

1. Initial canvas: replaced the old brand presentation with document sections. Corrected small ordered-list typography and removed token-name code backgrounds; the final comparison images contain these corrections.
2. Persistence review: corrected duplicate reads, incomplete local-workspace scope, derived-output synchronization, source journaling before overwrite, the history size mismatch, and filtering of restorable manual revisions. Regression tests passed.
3. Template verification: the first fragment-based project produced a blank preview. Templates now materialize complete HTML documents; the new project was visibly verified with working inputs and save feedback.
4. Final desktop/mobile review: no actionable P0/P1/P2 finding remains in the implemented workbench scope. Minor stylistic differences from Claude's proprietary fonts and toolbar are intentional.

## Explicit boundaries

Figma/repository URLs are source associations; remote access still requires the user's real connector authorization. No bidirectional Figma synchronization was implemented or claimed. Starter implementations are editable HTML drafts, not published framework packages. Contrast checks cover recognized opaque hex pairs; the manual checklist and product-specific component accessibility still require review. Package usage counts are static references, not production telemetry.
