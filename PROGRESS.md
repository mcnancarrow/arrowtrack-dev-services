# Arrowtrack Forge — Progress & Status

> **Forge** — AI app-builder / quote / deploy tool. _"Dream It. Describe It. Build It."_
> Express.js single-file server deployed on Railway (auto-deploys on push to `main`).

_Last updated: 2026-05-31_

---

## What it is

A customer-facing wizard that takes a business through a guided brief, generates a
live HTML demo of their app with AI, shows a real-time quote, collects a Stripe
deposit after human review, and tracks the build in a customer portal. An admin
dashboard sits behind it for review/approval and pipeline management.

## Architecture (current)

- **Server:** `server.js` — single-file Express app. Auto-deploys to Railway ~60–90s after push to `main`.
- **Generation:** `generator.js` — Anthropic SDK (`claude-sonnet-4-5`), `deliver_files` tool, streaming
  (`messages.stream(...).finalMessage()`) to allow a large token budget without the SDK's 10-minute guard.
  Long generations run via **fire-and-forget** endpoints so the Railway HTTP gateway timeout (~230–300s → 502)
  never applies.
- **Storage:** Railway Postgres `forge_kv` (key/value JSONB) with a local JSON fallback.
- **Secrets:** `ANTHROPIC_API_KEY`, `ADMIN_USER`, `ADMIN_PASS` live **only** as Railway env vars
  (never hardcoded/committed).
- **Front-end:** static pages in `public/` (no build step) — see below.

### Pages (`public/`)

| File | Purpose |
|------|---------|
| `index.html` | Marketing landing page |
| `build.html` | The build wizard (brief → live demo → quote → agreement) |
| `login.html` | Customer portal login |
| `reset.html` | Customer password reset |
| `project.html` | Customer portal — track build, review quote, manage payments |
| `admin.html` | Admin dashboard — review/approve, pipeline, regenerate |

---

## Brand system (metal forge — 2026-05-30)

Steel-grey + cool-blue "forge metal" identity. Logo is an **anvil + raised hammer** emblem
(inline SVG, scales to favicon). Wordmark is a **single forge-blue** "FORGE" in Saira Condensed
with an "ARROWTRACK" eyebrow.

| Token | Value | Use |
|-------|-------|-----|
| `--brand` | `#3B82F6` | Primary forge blue (wordmark, accents) |
| `--brand-dark` | `#2563EB` | Hover / deep blue |
| `--accent` | `#60A5FA` | Bright blue accent |
| `--dark` | `#16191F` | Gunmetal base |
| `--dark2` | `#22272E` | Surface |
| `--dark3` | `#2A3038` | Raised surface |
| `--gray` | `#9AA3AF` | Muted text / steel-light |
| `--white` | `#E6E9ED` | Body text |

Status/tag tints use cool-blue variants `#93B8FF` / `#7DACFF` / `#BFD4FF` so states stay
distinct while on-brand. Fonts: **Saira Condensed** (wordmark/headings) + **Inter** (body).

> **Note:** Only Forge's own product chrome uses this palette. AI-generated customer demos
> keep their own per-customer colors.

---

## Generation pipeline (current)

**One self-contained call.** Earlier the wizard fired an AI call on every step (6 calls,
~$1.50, 6 failure points). It now collects the full brief and fires a **single**
`generateExample()` call at the review step — one self-contained `index.html`
(CSS in `<style>`, JS in `<script>`, in-page anchor nav). ~$0.30, one failure point.

- `max_tokens: 32000` (room for the rich "wow" prompt without truncating the tool-call JSON).
- Respects the customer's `color_mode` / `color_primary` / `color_secondary` / `font_style` /
  `design_notes`; restaurant briefs get menu/order sections.
- Cost discipline: do **$0 static verification before any paid generation**.

---

## Changelog (by milestone)

### 2026-05-28 — Foundation
- Initial landing page; Forge interactive app builder with live pricing.
- Admin HTTP Basic Auth (fail-closed); customer portal (email+password) + My Project page.
- Railway Postgres storage with JSON fallback; admin delete; review-first payment workflow;
  optional monthly Care Plan.

### 2026-05-29 — Funnel, generation engine, deploy pipeline
- Account-gated funnel + per-step server draft save; fixed recursive autoSave freeze.
- Progressive AI generation engine with live preview panel.
- Password reset flow; admin Log Out.
- Auto-deploy pipeline (GitHub repo + Netlify + screenshot on submit); custom domain assignment.
- 90/10 human-review workflow — AI builds, admin approves before billing; "Regenerate All".

### 2026-05-30 — Quality, restaurants, single-call refactor, rebrand
- File-editor "👁 Preview"; moved sign-up gate to the review step ("fully vested" moment).
- Customer portal live preview (tabbed, page-by-page); generator emits separate pages.
- Mobile hamburger nav; wizard progress pills.
- Restaurant fast-track: industry presets + menu upload + restaurant generator.
- Universal content upload with AI vision extraction.
- Layout/overflow hardening across wizard + admin; self-healing admin quote totals.
- Premium "wow" generation tier; streaming API; **collapsed 6-step pipeline → single call**.
- **Metal forge rebrand** (anvil+hammer logo, forge-blue/gunmetal) across all six pages.

### 2026-05-31 — Pipeline validation, deploys live, deploy-pipeline bug fixes
- Validated the single-call generator on both pending accounts (no truncation):
  - **Ché Empanadas** (`SOW-MPSS926W`) — regenerated, reviewed, **first-time deploy → live** at
    `forge-sow-mpss926w.netlify.app`.
  - **Me\*Yioung** (`SOW-MPSUNO2J`) — regenerated from old 2-file format to single self-contained
    `index.html`, reviewed, **redeployed → live** at `forge-sow-mpsuno2j.netlify.app`.
- **Bug fix — deploy screenshots never captured** (`deployer.js` `takeScreenshot`): the Microlink URL
  used `&embed=screenshot.url`, which returns raw PNG bytes and broke `res.json()`, so the call always
  returned `null`. Dropped the `embed` param → plain JSON now yields `data.screenshot.url`. Affected
  **all** sites (shared by `deployProject` + admin redeploy). Verified live: both sites now show thumbnails.
- **Bug fix — stale deploy errors** (`server.js` redeploy success path): now sets `deploy_error: null`
  on a successful redeploy, so a healthy site no longer shows a leftover failure message.
- Confirmed both fixes cover the **new-account signup flow** (`deployProject` calls the same
  `takeScreenshot`) — future wizard submissions get working screenshots automatically.
- Noted: **regenerate** (updates stored preview) and **redeploy/publish** (pushes to the live Netlify
  site) are two distinct steps — the live URL only changes on redeploy.

---

## Roadmap / TODO

- [ ] **Agreement / SOW step** — near-term critical path after the single-call demo.
- [ ] **Regenerate/Publish UX** — lock the button while running, show progress (indeterminate, since
      it's one call), re-enable with a result toast; make the two-stage "Regenerate (preview) → Publish
      (redeploy)" distinction explicit in admin so it's always clear if the live URL is current.
- [ ] Make Postgres the primary store (reduce reliance on JSON fallback).
- [ ] Add/verify Railway env vars are complete.
- [ ] Delete the old `sow-builder` repo (superseded by Forge).
- [ ] StoreKit/Stripe IAP polish.
- [ ] Marketplace (on hold).

---

## Conventions

- **Cost discipline:** verify statically (free) before any paid API generation run.
- **`arrowtrackusa.com` is the user's main company site, NOT Forge** — do not navigate there.
- Generated customer demos keep their own palette; only Forge chrome is rebranded.
- Git commits are auto-signed; never amend, never skip hooks.
