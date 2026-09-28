---
name: Expiry audio priming race
description: Avoid stranding sequential countdown alarm playback when gesture priming races an active bell.
---

When one HTML audio element serves both gesture priming and ended-driven alarm playback, priming must not pause or reset an active alarm. Guard both the initial gesture handler and its asynchronous play-promise completion; an expiry can begin between those two moments.

**Why:** A paused audio element will not emit `ended`, leaving a sequential alarm queue blocked and suppressing later countdown alerts. Gesture priming can run after autoplay has already permitted a bell to start.

**How to apply:** Test the first pointer/key interaction during an active expiry, plus a priming promise that settles after expiry starts. Keep the playing element unmuted and let its normal `ended` events advance the sequence.