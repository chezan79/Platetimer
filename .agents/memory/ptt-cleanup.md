---
name: PTT cleanup (Step 10)
description: What was removed in the Intercom/PTT cleanup and what was deliberately kept
---

## Rule
Voice Messages (`voiceMessage` WS action, `voiceMessages` Map in dept/sala HTML, recording UI) are a SEPARATE active feature — do NOT conflate with PTT.

PTT = `ptt-voice.js` + `talkingStart`/`talkingStop` + WebRTC signaling (`joinVoice`, `offer`, `answer`, `ice-candidate`, `leaveVoice`).

**Why:** The name `ptt-voice.js` and the `voiceMessage` action look related but are completely independent systems. The cleanup required careful tracing before deletion.

## What was removed
- `public/js/ptt-voice.js` — deleted (no active HTML loader confirmed before deletion)
- `server.js` handlers: `joinVoice`, `offer`, `answer`, `ice-candidate`, `leaveVoice`, `talkingStart`, `talkingStop`
- `server.js` `isVoiceMessage` rate-limit exemption const (exempted only the removed actions)
- `public/i18n/{it,en,fr}.json`: `dept.tabIntercom` and `dept.intercom` keys
- CSS comment "PTT" mention in `public/department.html`

## What was kept
- `voiceMessage` WS handler and all Voice Message infrastructure (recording, send, receive, playback)
- `voice-recipients.test.js`, `voice-sala.test.js` — all 46 tests green after cleanup

## Test file changes
- `tests/service-s1-5.test.js` test 8 (talkingStart deptName) and joinVoice room locking section removed; replaced with explanatory comments. Test count: 43 → 39 (4 PTT-specific assertions removed, which is expected).

**How to apply:** If anything named `ptt`, `PTT`, `intercom`, `Interfono`, `talkingStart`, or `talkingStop` appears in a future PR, treat it as a regression against this cleanup.
