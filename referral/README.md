# Referral Revenue Calculator

**[Try it →](https://nazmh-referral-calculator.static.hf.space)**

Many B2B software companies have happy customers who would recommend them, but they do not know whether a referral programme is worth the effort. This tool answers that with their own numbers. It shows how many new customers referrals could bring in over a year, what they would cost, and how that compares with winning the same customers through paid channels.

## What you enter

- Paying customers today, the average value of a customer a year, and what paid channels cost to win one
- The share of customers lost each year
- How customers buy: they sign up themselves, or through a sales team (with your win rate)
- The reward for each new customer, and the monthly cost of running the programme
- How cautious the assumptions should be: Cautious, Typical or Strong

## What you get

- New customers and annual revenue from referrals over 12 months
- Cost per new customer, compared with paid channels, and how quickly it pays back
- How referrals turn into customers, and a month-by-month chart
- Which number to improve first, from a what-if table
- A short, plain-English review from Claude

## How it works

1. Each month, a share of customers refer one person. A share of those sign up, and a share of sign-ups become paying customers. For sales-led companies, the tool uses your own win rate, raised a little for referred leads, and deals close about three months after sign-up.
2. The programme builds to full strength over six months, and new referred customers can refer others too.
3. Every number is calculated with fixed formulas, in the browser and again on the server. AI never produces a figure.
4. Claude reviews the finished figures only. It is one short call per review, with no web search, and reviews are kept for 24 hours so asking again is free.

## Where the assumptions come from

| Assumption | Cautious | Typical | Strong | Source |
| --- | --- | --- | --- | --- |
| Customers who refer each month, at full strength | 2% | 5% | 10% | Cello customer data, 2026 |
| Referred people who sign up | 5% | 15% | 25% | Cello platform data |
| Sign-ups who become paying (self-serve) | 5% | 8% | 12% | ProfitWell, quoted by GrowSurf |
| Uplift on your win rate (sales-led) | none | 25% | 50% | Assumption, no reliable published figure |
| Referred customers cancel less often | not assumed | 18% | 18% | Schmitt, Skiera and Van den Bulte (2011) |

Most published referral benchmarks come from companies that sell referral software, so the Cautious setting uses the low end of each range. This is a planning estimate, not a forecast.

## Files

| Path | Purpose |
| --- | --- |
| `index.html` | The page, including the formulas |
| `refmaths.js` | The formulas on their own, shared word for word with the server |
| `example.json` | A saved example review, shown when the page opens |

The server side is the shared Worker in [`../worker/worker.js`](../worker/worker.js).

Built by Nazia Hossain.
