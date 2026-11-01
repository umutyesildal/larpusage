# Product brief

## One line

A profile page for how much AI you actually use — and for the usage you want to show.

## Who opens it

1. **The operator** — uses three or four coding agents across two machines. Wants one honest record of tokens, streak and what it would have cost at API rates. Opens it weekly, screenshots it occasionally.
2. **The larper** — used Claude on a laptop, Codex on a work machine, ZCode on a trip, Windsurf before it died. The local machine only knows a fraction. Wants a profile that reflects the whole story, not the accidental leftovers on one disk.
3. **The bystander** — sees the screenshot, asks "what is that". The page has to explain itself in four numbers and one grid.

## What it is for

- **Truth:** read every local agent store, never invent a number, show `—` where a tool reports nothing.
- **Composition:** let someone add the usage that isn't on this machine, with an exact total and a real date range.
- **The flex:** a calm, dark profile that looks like a product, not a dashboard.

## Two modes

| Mode | Reads | Adds | Feels like |
|---|---|---|---|
| **Real** | only detected local sessions | nothing — the add UI is hidden | a receipt |
| **Larp** | local sessions + added sources + earlier months | providers, totals, ranges, AI-generated specs | a passport |

Real is not a subset of Larp in the UI; it is a different contract. If a number is not on disk, Real does not show it.

## The larper's flow

1. Open **Studio** (`Cmd+K`).
2. Switch to **Larp**.
3. Look at **Detected here** — what this machine already knows.
4. **Add tokens**: pick a provider card (Claude / ChatGPT / OpenCode) or **Other** for the full list, enter the total, the range, the shape.
5. Watch the **Preview** on the right: lifetime, sources, the 84-day strip.
6. Optional: describe the usage in a sentence and let **Build with AI** produce the sources.
7. **Save**. The profile behind updates in place.
8. Screenshot.

The whole loop should take under a minute, and the preview must make the result obvious before saving.

## What the Studio is not

- Not a settings page. It composes the artifact.
- Not a form dump: provider first, then one total, one date range, one shape.
- Not a manual tool. Providers only — no free-text "manual" source.
- Not available in Real mode. Real is read-only.

## Honesty rules

- A detected source is never editable.
- An added source is always marked as added, and only exists in Larp.
- Cost is computed from a rate card; credits are shown as credits.
- A missing measurement renders `—`, never `0`.
- Nothing on the profile page says "demo", "mock" or "synthetic". The mode switch is the only tell.

## Success

A stranger can answer, in five seconds: whose profile is this, how many tokens, how long have they been at it, and what would it have cost. Then they ask how to make one.
