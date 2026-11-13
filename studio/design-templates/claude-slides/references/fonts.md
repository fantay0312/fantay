# Typefaces and the look

Read this when you choose the typefaces and colors for the deck, or when a user gives you font files. The active design system's fonts and palette always come first; everything below is for a deck with no design system, or for the choices a system leaves open.

## Where fonts come from

1. **The active design system.** Bind `--font-display` and `--font-body` (and the palette) from its `tokens.css` into the framework's `:root` slot. Its font files are referenced by the paths its package declares. Do not substitute other faces.
2. **A font file the user gives you.** Copy it into the project next to the deck and declare it:
   ```html
   <style>@font-face { font-family: "Acme Sans"; src: url(AcmeSans.woff2); font-display: swap; }</style>
   ```
   A static font with one weight renders every weight at that one weight; prefer a variable file, or the single weight you use most. Never embed a font as a `data:` URI.
3. **Google Fonts.** The normal case when nothing else applies. One `<link>` in `<head>`, several families allowed, spaces in names written as `+`, weights as `:wght@400..800` or a list, no `%` escapes:
   ```html
   <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Heading+Face:wght@400..800&family=Text+Face:wght@400;600&display=swap">
   ```
   Use the family in a stack that ends in a basic face and a generic: `font-family: "Heading Face", Georgia, serif`. Basic faces that work everywhere: Arial, Verdana, Tahoma, Trebuchet MS, Georgia, Times New Roman, Courier New. Put names with spaces in quotes.
4. **Chinese, Japanese, Korean text.** Name a CJK family (for example Noto Sans SC or Noto Serif SC) in the stack, with the Latin face first.

Use at most four families; two is the norm. A static `<style>` in the head may hold the `@font-face` rules and the per-deck classes; the framework's own `<style>` block is never edited.

Symbols the typeface lacks (check marks, stars, dingbats) fall back to a system font. Draw a check mark as inline SVG, or use a word or a plain minus for "no".

## Default picks, when the brief and the design system leave it open

All Google Fonts families.

**Text (body) typeface, choose one.**
- sans: DM Sans (modern consumer), Nunito Sans (friendly neutral), Rubik (soft grotesk, product), IBM Plex Sans (technical, enterprise), Public Sans (civic, quiet)
- rounded: Nunito (education, wellness), Quicksand (light, airy), Fredoka (kids, bold consumer)
- serif: EB Garamond (academic, heritage), Libre Baskerville (editorial, reports)
- slab: Domine (friendly-serious)
- mono: JetBrains Mono, Fira Code (developer decks, code)

**Display (heading) typeface, choose one from a different row than the text typeface.**
- sans: DM Sans, Rubik
- serif: EB Garamond, Libre Baskerville, Source Serif 4, Cormorant Garamond (delicate; display sizes only)
- slab: Domine
- condensed: Oswald (posters, sports, statements)
- rounded: Nunito, Fredoka
- calligraphic: Dancing Script (one line only, never body text)
- hand-drawn: Caveat (one accent line only, never body text)

Any other Google family is fine when you have a deliberate direction (Playfair Display, Lora, Bitter, Work Sans, Space Grotesk, Montserrat, Syne).

## Pairings by mood

- Editorial or magazine: Rubik + Libre Baskerville, or Libre Baskerville alone (headings at 700)
- Luxury or hospitality: Cormorant Garamond + Rubik (light)
- Institutional, research, policy: EB Garamond + IBM Plex Sans, Libre Baskerville + Public Sans, or Source Serif 4 + IBM Plex Sans
- Literary, non-profit, education: Domine + Nunito Sans, or Libre Baskerville alone
- Academic or heritage: EB Garamond alone (headings at 600)
- Product, startup, SaaS: DM Sans alone, or Rubik + Domine
- Developer or infrastructure: IBM Plex Sans + JetBrains Mono, or Rubik + Fira Code
- Bold, poster, sports: Oswald + Public Sans, or Oswald + Rubik
- Playful or consumer: Fredoka + Nunito Sans, Quicksand alone, or a Caveat accent line over Nunito Sans
- Quiet or minimal: Public Sans alone
- Celebratory or invitation: Dancing Script (one line) + EB Garamond
- Warm editorial default of this template (`example.html`): Source Serif 4 headlines + DM Sans body, on ivory, slate and clay.

Vary between decks. Do not choose a typeface only because it is first in a list.

## Rules that keep a deck from looking generic

- Two faces is the norm; a third only with a clear job. A distinctive display face with a refined text face beats two safe faces.
- Color in hex, chosen once: one dark, one light, zero to two accents. Two accents share chroma and lightness but differ in hue. Tone the whites and blacks toward the palette (`#FBFBF8`, `#14213D`); no raw `#FFFFFF` or `#000000` unless the stark look is the point. Two background tones per deck plus one accent statement slide. Set `background` on every slide.
- Contrast is a number: body text at least 4.5:1 against its background, display sizes at least 3:1. A light accent (like `#E8C547`) takes dark text. Accent used as small text on a light ground may need a darker step than the accent used as a fill.
- Color never says it alone. A status, a good-or-bad split, the winning bar, a risk level or a highlighted cell also says so in its text ("+4%, over plan", "High risk"). A dash, a check mark or an icon standing for a word gets the word beside it.
- The type scale is the hierarchy: four or five sizes, for example 120 / 72 / 44 / 32 / 24, reused across the deck. Accent color for eyebrows. Dark tone for headings on a light ground, light tone on a dark ground. Body text in a softened color (`#4A5568` on light, `#BFD8D5` on dark).
- Typographic punctuation in all text people read: `’` for the apostrophe and the quotation marks of the text's language (`“ ”` in English, `« »` in French, `„ “` in German). Straight quotes stay in markup, code and measurements (feet and inches).
