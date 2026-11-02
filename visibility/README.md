# AI Search Visibility Check

**[Try it](https://nazmh-ai-search-visibility.static.hf.space)**

## The problem

Buyers now ask AI assistants which suppliers to shortlist. Most marketing teams have no way of knowing whether their brand is named in those answers, or which competitors are named instead.

## What it does

You enter a brand, its category, a country and up to four competitors. The tool then:

1. builds five typical buyer questions from the category and country, for example "What are the best CRM platforms in the United Kingdom?";
2. asks Claude each question three times with no web access, to show what the model already knows, and once with live web search, to show what it finds today;
3. counts how often each brand is named and where it appears in the answer, using fixed rules rather than AI;
4. uses AI only to spot other brands the answers mention, so new competitors appear;
5. lists the websites live search relied on, so you can see which sources shape the answers.

## How it is built

The page is a single static HTML file hosted on Hugging Face. It calls the shared Cloudflare Worker in [`worker/worker.js`](../worker/worker.js), which holds the Claude API key as an encrypted secret, limits each visitor to two runs a day and all visitors to 20, and saves each result for 24 hours so a repeat check is free.

Technologies used: JavaScript, Cloudflare Workers, Cloudflare KV, Claude API with web search, Hugging Face

## What it cannot tell you

AI answers change from person to person, with their history, settings, location and the model version. This check asks neutral questions with no personal context, so treat it as an estimate and a trend to watch, not what any one buyer sees.
