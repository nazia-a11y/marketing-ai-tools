# Pipeline Planner

**[Try it](https://nazmh-pipeline-planner.static.hf.space)**

## The problem

Marketing plans often start from the budget available rather than from the revenue the business needs. Many businesses are also still working out their own funnel numbers, so they cannot see which stage is holding them back.

## What it does

You enter a revenue target, average deal size, sales cycle and the share of revenue expected from marketing. You then describe your funnel in one of two ways: every stage, or just the basics (how many leads become opportunities, and your win rate). If you are not sure of your rates, a helper works them out from last quarter's counts. The tool then shows:

1. the leads, opportunities, pipeline and marketing budget needed each month and each year;
2. a funnel chart of the volumes needed at each stage;
3. how much budget a five-point improvement at each stage would save, so the real constraint is clear;
4. the budget needed for each lead source;
5. a plain-English review from Claude, covering a summary, the biggest constraint, the risks and the next steps.

## How it is built

Every number is calculated with fixed formulas, in the browser and again on the server. AI never produces a figure. Claude is only asked to review the finished figures, in one short call with no web search, so each review costs a fraction of a penny.

The page is a single static HTML file hosted on Hugging Face. It calls the shared Cloudflare Worker in [`worker/worker.js`](../worker/worker.js), which holds the Claude API key, limits each visitor to five reviews a day and all visitors to 30, and saves each review for 24 hours.

Technologies used: JavaScript, Cloudflare Workers, Cloudflare KV, Claude API, Hugging Face

## What it cannot tell you

This is a planning model, not a forecast. It assumes the rates hold steady across the year and every lead costs the channel average. Use it to find the constraint and test what-if scenarios, then check the result against your own CRM data.
