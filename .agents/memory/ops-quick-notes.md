---
name: Operations Quick Notes
description: Durable rules for personal Quick Notes persistence, conversion, and optional voice capture.
---

Quick Notes are personal to the canonical Operations Firebase UID as well as the company. A note-to-task conversion must persist the task, conversion audit history, and note provenance as one awaited cross-store operation; use a Firestore batch when Firestore is configured and a durable write-ahead journal when using local files.

**Why:** Independent asynchronous store writes can acknowledge a conversion while leaving its task audit trail or source-note status out of sync.

**How to apply:** Any future conversion-like feature that changes Operations tasks and a separate store must make the persisted task authoritative only after every related record is committed, and must roll back in-memory changes on persistence failure.

Voice capture is optional and ephemeral. Closing the capture UI must invalidate the active capture generation and abort/ignore both a late microphone permission result and a late transcription response.

**Why:** MediaRecorder and browser permission/transcription callbacks can fire after the modal is closed; audio and transcript text must never be retained or applied after cancellation.

**How to apply:** Keep a per-capture generation/cancellation token through permission, recording, and transcription, stop tracks immediately, and test cancellation at each asynchronous boundary.