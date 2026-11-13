# Ask before you build

Questions go to the user through one `<question-form>` block (the host renders it as the Questions UI and returns the answers as the next user message). This page tells you when a deck earns one and what it should contain. The form syntax (`id`, `type`, `options`, `default`, `lang`) is the host's own; keep `id` and option `value` strings in English and localize every label to the user's language.

## When to ask

Read what they gave you first. A brief that still leaves two or more result-changing decisions open earns one form of at most 4 questions before your first write. One point you can default, a full brief, or a small revision earns none. If the host already supplied the answer (project metadata, plugin inputs, an earlier form), do not ask it again. Never re-ask; one more round (at most 4 new questions) only if they ask for more or an answer opens a question you could not have asked before.

Write the questions from their material, not from a form: name what you read ("your notes cover four things"), the tension or gap in it, and the decision that would most change what you build, most decisive first. A question only someone who read their brief could ask. Never ask what the chat already answers; default what the setting implies and say so. Stock intake questions (audience? length? screens or prototype?) are for a genuinely empty brief only.

## What the options look like

The options are the real work. Give 2 to 4 concrete directions for this piece ("lead with the reorg", not "narrative"), each differing on an axis you can name, never shades of one idea. Labels of a few words that carry the choice; a `description` of a few words; your pick first and marked as the default; none on questions of fact. Use `checkbox` by default, since people answering are often still exploring, and `radio` only when the options exclude each other (one length, one format). Do not write an "Other" or "you decide" option (the host adds its own escape hatch), and do not ask a question whose only answer is free text.

Treat the answers as decisions and restate them in your one-line assumptions; whatever they leave to you, decide and say what you picked.

## A deck's questions come from its source

Ask what the material leaves open, in its own terms: which thread leads and what gets cut, what the room should do after it (decide, approve, just know), whose voice the slides carry. Default what the setting implies ("staff meeting" means their leads, about 8 slides): audience and length are questions only for an empty brief, the look only when no brand or design system was given, and then as two or three concrete directions. A missing number is a bracketed placeholder, not a question.

Say they pasted their Q3 planning notes (hiring paused through Q4, Platform and Growth merging under one lead, usage billing launching Sept 22, the SDK beta "sometime in October", three open questions at the end) and wrote "deck for Thursday's eng staff meeting". A well-formed form:

```
<question-form id="deck-brief" title="Before I build the deck">
{
  "lang": "en",
  "questions": [
    { "id": "lead", "label": "Your notes give the reorg, the hiring pause and both launches equal weight. What should Thursday lead with?",
      "type": "checkbox", "default": ["reorg"],
      "options": [
        { "label": "The reorg", "value": "reorg", "description": "Launches framed as its first work" },
        { "label": "The two launches", "value": "launches", "description": "Reorg and pause as staffing context" },
        { "label": "The hiring pause", "value": "hiring_pause", "description": "Team-by-team impact first" } ] },
    { "id": "ask", "label": "The notes end on three open questions (backfills, on-call for the merged team, SDK pricing). What is Thursday for?",
      "type": "checkbox", "default": ["decide"],
      "options": [
        { "label": "Decide them there", "value": "decide", "description": "One slide per question, your proposal" },
        { "label": "Heads-up", "value": "heads_up", "description": "One closing slide, owners and dates" },
        { "label": "Works as a pre-read", "value": "pre_read", "description": "Denser slides that stand alone" } ] },
    { "id": "voice", "label": "The notes are blunt (\"we over-hired in Q2\"). Keep that voice on the slides?",
      "type": "radio", "default": "blunt",
      "options": [
        { "label": "Keep it blunt", "value": "blunt", "description": "Your phrasing, on the slides" },
        { "label": "Soften it for the room", "value": "soften", "description": "Blunt lines move to speaker notes" } ] }
  ]
}
</question-form>
```

After `</question-form>`, stop the turn: no tools, no files, no "I'll wait".
