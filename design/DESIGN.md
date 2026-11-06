# Design template for the marketing tools

`template.html` is the shared layout for every tool in this repository. It was first built for the Global Hiring Planner. Copy it, keep the CSS as it is, and replace the placeholder content.

## Colours

- Navy `#1C2B4A`: top band, headings, primary buttons
- Clay `#B07A5A`: accents, the answer bar strip, figures that are good news
- Paper `#F6F3EE`: page background below the band
- White `#FFFFFF`: cards and the answer card
- Ink `#1F2430`, soft `#4A5060`, muted `#7A7F8A`: body text in three strengths

## Type

- Newsreader (serif) for headlines, the answer and large figures
- Inter for everything else
- Sentence case throughout. No capitals for labels, no small text above headings.

## Layout

1. **Navy band.** Navigation, then a hero in two columns. Left: the question as the headline, one or two sentences, and a panel with the few inputs that change the answer most. Right: the white answer card.
2. **Answer card.** A context line, the answer as a serif sentence, one line on why, one small picture, three figures, up to three notes, and a source line that says how the figures are worked out and whether AI is used.
3. **Fine-tune.** The heading sits in the navy band and the cards rise into it, so visitors see there is more without clicking. Cards sit in two columns.
4. **Answer bar.** A white bar with a clay strip slides in once the answer headline scrolls away. It starts with a label naming what it shows, such as "Suggested route:".
5. **Why this answer.** The detail: full charts, checks, timelines.
6. **Second opinion from Claude.** A navy panel. Claude only reviews finished figures and never changes them.
7. **How this works.** Steps and sources, then the footer.

## Writing

- Labels say what the visitor knows, in their words: "Have a quote already? Replace our typical costs", not "Use your own quote".
- No contractions, no buzzwords, no middle dots between items.
- Every visible input must change the answer. If it does not, remove it.
