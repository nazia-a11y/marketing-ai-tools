# Expansion Route Planner

**[Try it →](https://nazmh-expansion-route-planner.static.hf.space)**

A company hiring in a new country has two main routes. It can employ people through an employer of record, which employs them on its behalf, or it can set up its own local company. This tool shows which route fits the hiring plan, when to switch from one to the other, and what each costs over 24 months, then asks Claude for a plain-English review.

## What you enter

- The type of country (simpler, more complex or most complex), whether you work in the local language, and the currency
- How many people you need now, in 12 months and in 24 months, and how soon you need the first hire
- Whether the people will work only for you, full-time and under your direction
- Four risk questions: local sales or contract signing, a local manager, local licences or tenders, and regulated sectors
- Whether you plan a permanent local presence, and whether this is part of an acquisition or carve-out
- Four costs, prefilled with typical figures: the employer of record fee, setup, running costs and payroll

## What you get

- The recommended route and a numbered plan with the months to act
- The total cost over 24 months for each route, and a month-by-month chart
- The three checks (cost, risk and strategy) and any warnings
- A short, plain-English review from Claude, with questions to confirm with an adviser

## How it works

1. The hiring plan becomes a headcount for each of the next 24 months, in a straight line from now to 12 months to 24 months.
2. Employer of record costs the monthly fee for each person. Your own company costs a one-off setup, a fixed monthly running cost and payroll for each person. Salaries and employer taxes are the same either way, so they are left out.
3. The tool finds the month when your own company becomes cheaper to run, and checks whether switching then saves money over 24 months once setup is paid for. Employer of record covers the months while the company is being set up.
4. Three checks follow: cost, risk and strategy. Your own company is recommended when at least two point to it. Risk answers can bring the switch forward.
5. Every number is calculated with fixed formulas, in the browser and again on the server. AI never produces a figure. Claude reviews the finished figures only, in one short call with no web search, and reviews are kept for 24 hours.

## Where the assumptions come from

| Assumption | Value used | Source |
| --- | --- | --- |
| Employer of record fee | £475 a person a month (about $599) | Provider pricing pages, $499 to $699 (Teamed, 2026) |
| Setup cost and time | £6,000 to £20,000, 2.5 to 5 months, by type of country | Teamed, Lano, WorkMotion |
| Running your own company | £1,200 to £3,500 a month before salaries | Teamed |
| Not working in the local language | Running cost raised by 30% | GoGlobal, WorkMotion, Teamed (30% to 50%) |
| The three checks | Cost, risk and strategy | Published guidance on moving from employer of record to your own company |

This is general guidance for planning, not legal or tax advice. Rules differ by country, so confirm the route with an adviser in that country.

## Files

| Path | Purpose |
| --- | --- |
| `index.html` | The page, including the formulas |
| `routemaths.js` | The formulas on their own, shared word for word with the server |
| `example.json` | A saved example review, shown when the page opens |

The server side is the shared Worker in [`../worker/worker.js`](../worker/worker.js).

Built by Nazia Hossain.
