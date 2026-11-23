# HELMUTS EXPEDITIONS

Blind-first manuscript transcription as an adventure. Built on Ember; costs cents per plate.

Snap a photo of a manuscript plate and join an expedition: the page is
transcribed blind — from the photo alone — then checked against what's
published, with every uncertainty marked and nothing invented. Ten
dollars of API credit transcribes thousands of plates.

Live: https://helmutreads.com

## The $10 math

Measured per plate (Meta Muse Ember via OpenAI-compatible API):

- Blind transcription: ~3.0K input / ~6.4K output tokens
- Cross-reference compare: ~2.4K input / ~2.9K output tokens
- Web searches for published parallels: flat per-request

A full run is roughly 15K tokens — a fraction of a cent. The whole
12-plate validation batch behind this entry cost less than a coffee.

## Prior work (disclosure)

The transcription engine (blind transcribe → research compare →
billing → review queue) pre-exists at helmutreads.com, built before
this event. This entry's hackathon-new work: the expedition experience
(sample-driven adventure flow over the same engine), live cost
visibility, and everything committed here Nov 23 – Dec 2, 2026.

## Run it

```powershell
npm ci
npm test            # 38 tests, must all pass
npm run typecheck   # client + server, must be clean
npm run build:client
npx wrangler deploy # needs your own Cloudflare login
```

Copy `.env.example` to `.env` and fill in keys for local runs
(`npm start` → http://localhost:3105). Never commit `.env`.

## Method (the honest part)

1. Blind transcription first — the model sees only the photo.
2. Research compares against published references found on the web.
3. Verdicts describe the search only: "no match found" never means
   "unpublished". Gaps stay gaps ([?]), guesses stay marked.
