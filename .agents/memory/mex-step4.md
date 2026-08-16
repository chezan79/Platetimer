---
name: Mex Step 4 rendering
description: How Mex incoming messages are inserted into #cd-list alongside Countdown cards, coexistence rule, and notification sound.
---

## What was implemented

**File changed:** `public/department.html` only (no server changes).

### New JS state
- `const mexCdCards = new Map()` — tracks messageId → DOM element for deduplication.

### New functions
- `playMexSound()` — Web Audio API two-note descending ding (A5→E5, 0.6s). Fully independent from Voice Message audio and countdown alarms. Silent no-op if AudioContext unavailable.
- `insertMexCdCard(msg, isNew)` — inserts a `.mex-cd-card` into `#cd-list`. `isNew:true` adds `.new-arrival` class (3×0.9s pulse animation, auto-removed after 2.8s). Deduplicates via `mexCdCards`. Removes `.empty-state` if present.

### renderCards() refactor (coexistence)
**Critical rule:** `renderCards()` must NOT remove `.mex-cd-card` elements.
- Old: `list.innerHTML = sorted.map(...).join('')` — replaced ALL children including Mex cards.
- New: iterate `Array.from(list.children)` and only `.remove()` children that do NOT have `.mex-cd-card` class.
- Countdown cards are inserted via DOM `insertBefore(el, firstMex || null)` so they always appear BEFORE Mex cards.
- Empty-state only shown when there are NEITHER countdown cards NOR Mex cards.

### handleMexIncoming update
After existing `mexInboxMessages.push(msg)` + `renderMexInbox()`:
- calls `insertMexCdCard(msg, true)` — card in #cd-list with pulse
- calls `playMexSound()` — notification tone

### loadMexInbox update (backfill)
After existing `mexInboxMessages.push(...fresh)` + `renderMexInbox()`:
- calls `fresh.forEach(m => insertMexCdCard(m, false))` — backfill, NO animation, NO sound

### CSS added
- `.mex-cd-card` — blue gradient card (distinct from red/amber `.cdc` countdown cards)
- `.mex-cd-from`, `.mex-cd-icon`, `.mex-cd-body`, `.mex-cd-time` — sub-elements
- `@keyframes mex-pulse-arrive` — 3 × 0.9s finite pulse on arrival
- `.mex-cd-card.new-arrival` — applies the animation

### Tests
- `tests/mex-step4-render.test.js` — 30 plain Node.js + jsdom tests covering:
  - insertMexCdCard basics (id, new-arrival class, backfill class, dedup, multiple)
  - empty-state interaction
  - XSS escaping (body + sender name)
  - Coexistence: countdown does not remove Mex cards (verified 3 consecutive renderCards)
  - Coexistence: Mex does not remove countdown cards
  - DOM order: countdown before Mex
  - Countdown expiry: Mex cards remain, no stale empty-state
  - Sound: real-time plays sound, backfill does not

**Why:** Spec §8 requires that Countdown rendering not clobber Mex cards. The only safe fix is DOM manipulation that selectively removes non-Mex children instead of replacing all innerHTML.
