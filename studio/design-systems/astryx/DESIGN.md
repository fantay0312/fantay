---
name: Astryx
colors:
  background: "#f1f1f1"
  surface: "#ffffff"
  primary: "#1b1b1b"
  text: "#000000"
---

# Astryx

> Category: Developer Tools

Astryx is Meta's open-source design system for people and the agents working alongside them. This package adapts the official **Neutral** theme at `df15de7fc3941b479d3bfb8d4576a3b3c27bca3d` to FantayDesign's semantic token contract. It is a product-interface system with neutral emphasis, compact controls, clear hierarchy, and light and dark modes. Upstream is currently Beta.

## Visual direction

Use quiet neutral surfaces, dark primary actions, precise borders, and clearly grouped content. Let the user's work carry the visual interest. The default action color is near-black, not Meta's corporate blue. Informational blue belongs to status and focus. This package is separate from the existing Meta Store system, which describes retail marketing.

## Color roles and themes

Light mode maps Neutral's body to `#f1f1f1`, surface to white, primary text to black, secondary text to `#474747`, and primary action to `#1b1b1b`. Dark mode uses `#1b1b1b` body, `#262626` surface, white text, `#9e9e9e` secondary text, and `#f1f1f1` action fill. Use `--accent-on` for action labels. Apply dark overrides with `data-theme="dark"`; never invert the entire page.

Success, warning, and error fills follow upstream: `#198100` / `#64af4c`, `#ffce2f`, and `#c9303a` / `#ff705d`. Warning requires dark text. These status fills are not all suitable as small text on the canvas: use descriptive text in the normal foreground, plus an icon or label. Never communicate a state through color alone.

## Typography

Use **Figtree**, locally included with SIL OFL, for body and headings. Neutral's upstream scale starts at 14px with ratio 1.2; this normalized package uses rounded steps 12, 14, 17, 20, 24, 29, and 42px. The shared xs and sm slots both bind to the 12px minimum. Body leading is 1.5 and compact heading leading is 1.2. Use bold subsection headings and restrained display tracking. For coarse pointers on narrow surfaces, raise the body and input size to 16px, mirroring the upstream accessibility adaptation. Use platform monospace only for code and measurements.

## Spacing and composition

Use the upstream spacing rhythm of 4px at the standard 16px root: 4, 8, 12, 16, 20, 24, 32, and 48px. Related labels and controls sit closer than independent sections. The 1200px maximum, 24/20/16px responsive gutters, and 64/48/32px section gaps are FantayDesign layout compatibility bindings, not upstream global requirements. Keep reading text below about 70 characters per line.

## Controls and component vocabulary

Use native buttons for actions, anchors for navigation, explicit labels for fields, and native checkbox/select semantics when appropriate. Prefer one primary action per local task. Neutral radius roles map to 6px inner, 10px element, 12px container, and fully rounded pills. The upstream page radius is 28px, documented as a separate source role rather than inserted into the shared schema. Use subtle low elevation; dark elevation includes a 1px inset rim.

The local component fixture covers buttons, fields, selection, badges, navigation, tables, alerts, and disclosure. It demonstrates the normalized styling and native interaction, not the full official React library. For official APIs, read the preserved core docs and use React 19+ in the target app. Do not install Astryx into the React 18 Studio host as part of applying this design context.

## Interaction and motion

Neutral configures 125ms fast and 300ms medium motion; the standard easing is `cubic-bezier(0.24, 1, 0.4, 1)`. Use fast color/border transitions for controls and reserve medium motion for meaningful entrance or layout changes. Hover/pressed bindings in this package use adjacent neutral steps as local approximations of upstream overlay composition. Respect `prefers-reduced-motion` by removing optional movement. Keep visible keyboard focus using the informational blue focus role.

## Accessibility and states

Keep focus visible, preserve labels and native keyboard controls, and connect error text with `aria-describedby`. Include hover, focus, disabled, loading, invalid, and empty states in real product implementations. Use readable text colors rather than the upstream disabled gray for helper copy. Inputs on coarse-pointer narrow surfaces use 16px text, and touch actions should offer at least 44px targets where needed. Do not assume an upstream accessibility claim proves a new composition passes contrast or keyboard checks.

## Source fidelity and limits

The complete upstream commit is preserved in the material library; the package includes fixed source excerpts, license, token evidence, and a separately licensed Figtree font. Source definitions remain unchanged. The semantic token layer, HTML fixture, and responsive composition are authored adapters. Seven upstream theme packages are archived, but only Neutral is bound here. Upstream `lab` is unpublished; charts and Vega are canary-only. Neither official React runtime nor those experimental packages are validated by this fixture.

## Avoid

Avoid replacing the neutral primary action with corporate blue, using all caps for ordinary labels, filling every surface with cards, hiding field labels in placeholders, or using saturated status fill as low-contrast body text. Do not present the HTML fixture as the official 150+ React components, overwrite the Meta Store package, or change the application's default design-system selection when adding this package.
