# Global Hiring Planner

**[Try it →](https://nazmh-expansion-route-planner.static.hf.space)**

A company hiring in a new country has two main routes. It can employ people through an employer of record, which employs them on its behalf, or it can set up its own local company. Pick a country, a salary and how many people you need. The tool shows what each person really costs, which route fits, when to switch, and what each route costs over 24 months, then asks Claude for a plain-English review.

Countries covered: United Kingdom, Ireland, Germany, France, Netherlands, Spain, Poland, Singapore, Australia, Canada (Ontario).

## What you enter

- The country, the average salary, and whether your team works in the local language
- How many people you need now, in 12 months and in 24 months, and how soon you need the first hire
- Whether the people will work only for you, full-time and under your direction
- Four risk questions: local sales or contract signing, a local manager, local licences or tenders, and regulated sectors
- Whether you plan a permanent local presence, and whether this is part of an acquisition or carve-out
- Optionally, your own quotes for the employer of record fee, setup, running costs and payroll. Typical figures for the country are used otherwise

## What you get

- What one person costs a year: salary plus the employer contributions set by law in that country for 2026
- The recommended route and a numbered plan with the months to act
- The route costs over 24 months on top of pay, and a month-by-month chart
- The three checks (cost, risk and strategy), including country rules that limit employer of record, such as Germany's 18-month limit or Singapore's work pass rule
- A short, plain-English review from Claude, with questions to confirm with an adviser

## How it works

1. The hiring plan becomes a headcount for each of the next 24 months, in a straight line from now to 12 months to 24 months.
2. Each person costs their salary plus the statutory employer contributions for the country, using 2026 rates and ceilings. This is the same on either route, because an employer of record passes these costs on.
3. On top of pay, employer of record costs a monthly fee for each person. Your own company costs a one-off setup, a monthly running cost and payroll for each person.
4. The tool finds the month when your own company becomes cheaper to run, and checks whether switching then saves money over 24 months once setup is paid for. Employer of record covers the months while the company is being set up.
5. Three checks follow: cost, risk and strategy. Your own company is recommended when at least two point to it. Risk answers and country rules can bring the switch forward.
6. Every number is calculated with fixed formulas, in the browser and again on the server. AI never produces a figure. Claude reviews the finished figures only, in one short call with no web search, and reviews are kept for 24 hours.

## Where the assumptions come from

| Assumption | Source |
| --- | --- |
| Employer contributions, 2026 | HMRC, gov.ie, Deutsche Rentenversicherung and Techniker Krankenkasse, URSSAF rates published by CCI Paris, the Dutch government gazette, Seguridad Social, the official ZUS ceiling notice, the CPF Board, the ATO and Revenue NSW, the Government of Canada and the Government of Ontario, checked against PwC Worldwide Tax Summaries |
| Employer of record fee | About $599 a person a month, the common published starting fee, converted at rough exchange rates |
| Setup time and cost, running costs | Typical figures from local advisers and formation firms, so treat them as estimates |
| Country rules on employer of record | Legal briefings from Taylor Wessing (Germany), Addleshaw Goddard (France), Le Global (Ireland), CMS (Netherlands), Lawants (Spain), Dudkowiak (Poland), Jackson Lewis (Singapore) and the Government of Ontario |

Employer contributions cover statutory costs only, not optional benefits, sector agreements or workplace accident insurance where the rate depends on the sector.

This is general guidance for planning, not legal or tax advice. Rules differ by country, so confirm the route with an adviser in that country.

## Files

| Path | Purpose |
| --- | --- |
| `index.html` | The page, including the formulas |
| `routemaths.js` | The formulas on their own, shared word for word with the server |
| `example.json` | A saved example review, shown when the page opens |

The server side is the shared Worker in [`../worker/worker.js`](../worker/worker.js).

Built by Nazia Hossain.
