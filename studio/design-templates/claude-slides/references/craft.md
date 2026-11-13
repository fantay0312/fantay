# Writing a good deck: the long form

`SKILL.md` has the checklist. This page explains the reasons behind it. Read it if the user argues with a design choice, asks for a kind of deck the checklist does not cover (a keynote, a training deck), or asks for speaker notes. The rules live as craft sections too (`slide-composition`, `content-discipline`); this is the longer commentary. The cross-family content rules that every design follows are at the end.

## Writing a good deck

There is no house look. The fonts and palette come from the active design system, or from the ones you choose for the brief (`fonts.md`).

- **One idea per slide.** One big statement slide is better than three bullet-point slides. Several short slides beat one crowded slide.
- **128px edge margins** are the standard: `padding: 128px` on the slide. Pinned elements start 128px from an edge unless you have a reason not to.
- **Respect your type scale.** Choose four or five font sizes for the deck and use them again and again. Eyebrows (24 to 28px, uppercase, extra letter spacing, accent color) label things. Headings make statements. 40 to 48px for agenda-level points. 28 to 32px for sentences. Never less than 24px.
- **Change backgrounds on purpose.** The dark color for the opening and closing slides, the light color for the main content, the accent color for one statement slide: the single number or sentence you want people to remember. Always set `background` explicitly on every slide.
- **Width discipline.** Flow text inside the margins is 1664px wide, which is too wide for body text. Put sentences in a column 800 to 1000px wide (`width: 960px`, or a `flex: 1` column next to something else). Display lines work best at about 1400px. The other limit is the longest word. Count characters before you choose how many columns to use.
- **Vertical space budget.** The slide is 1080px tall and nothing shrinks to fit, so do the math for tall content. Inside the 128px margins you have 824px.
  - A two-line heading at 96px with line-height 1.1 is about 210px; a gap is 48px.
  - Each table row is about 2.1 x the font size per line of text in a cell. At 32px one row is about 70px; nine rows are about 630px and do not fit under the heading above. A cell with two lines counts twice.
  - A card body is lines x font size x line-height plus padding. Never set a fixed height on a text box smaller than that total; leave the height out.
  - Too tall: 24 to 28px in tables, or split the slide.
- Keep decks under about 50 slides.

### You are a presentation designer

Think like a consultant or executive preparing boardroom material: clarity, narrative flow, back-of-the-room readability. The slide is a fixed 1920x1080 page, designed like a poster, and each slide should make sense on its own.

Only ask what you cannot figure out on your own (how long the deck should be and who it is for, if the request does not hint at them). A topic and an occasion are enough to start a draft. When the user gives a font size it is in points: `px = pt x 2` ("36pt" is 72px).

### Outline and titles first

Write the outline first; the slide titles alone should tell the story, like a table of contents. Write the full title sequence in one grammatical style: short textbook-style topic titles ("Market Research", "Team Structure"), or action titles ("Asia is our largest market...", "...but Eastern Europe has the highest potential for growth"). Read just the titles: a person should understand the flow. Share the list of titles in chat before you start the slides, and wait for approval only if the request was unclear.

Avoid titles that sound like an AI wrote them: titles that deliver the verdict, are too dramatic, create fake tension ("It's not X. It's Y."), lean on heavy reframing or faux-insight ("The magic moment"). A title introduces the slide; it is not the speaker's punchline.

### Less text, more structure

Avoid too much text on slides. Decide which parts should be tables, diagrams, quotes, images, card rows or big numbers. Mix the look: full-image slides, different backgrounds, big numbers, quotes, tables and some text. Avoid a short block of text hanging under the heading with nothing below it. Use parallel design: section headers look the same, repeated elements sit in the same place, the heading is at the same height on every content slide, slides of the same kind share markup.

### Commit to the system up front

Say out loud the system you will use: a layout for each type of slide (section headers, title slides, content slides, image slides), and the variety and rhythm on purpose. On slides with a lot of text, commit to the user's imagery or to structure (a table, a card row, a big number). Do not use web-level density (14 to 16px body text). If the text only fits at 20px, there is too much text.

### Speaker notes

Only add speaker notes if the user asks (or project metadata says notes are on). Then the deck becomes visual-first and the notes carry the script: write them like a conversation, full text of what the presenter will say out loud, not bullet points. Because the notes carry the story, take text off the slides and use large figures, quotes, full-bleed images, diagrams and one-line headlines. If a slide has a lot of text, you have put the script on the slide.

### Compose like a slide designer, not a web designer

Decide each slide's composition as you write it. A statement or title slide with open space below is correct. A content slide whose column stops at 60% of the height reads as unfinished: fill the whole height with `justify-content: space-between` or a `flex: 1` spacer before the last row, the heading staying at the top margin at the same height as on the deck's other content slides. Center the content only on a slide with no heading above its body (a statement, a quote). Never center a column with a heading above its body: the column's height then sets where the heading lands, differently on every slide. Plan the `gap` so the blocks span the 824px.

## Content and design rules shared by every design

These are the same rules as the `content-discipline` craft section: no filler content, ask before adding material, targeted changes stay targeted, follow an existing design's visual vocabulary, avoid AI slop tropes, recreate from source rather than from memory or screenshots, and do not recreate copyrighted designs. Read `craft/content-discipline.md` (it is injected when this template runs).
