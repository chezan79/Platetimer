---
name: i18n dictionary integrity
description: The three public/i18n/*.json dictionaries are easy to corrupt; always JSON-validate after editing.
---

The rule: after any edit to `public/i18n/it.json` / `fr.json` / `en.json`, run `node -e "JSON.parse(...)"` on all three before finishing.

**Why:** A past change appended ~254 keys *after* the closing brace of each file. All three dictionaries became invalid JSON — the browser's `loadDictionaries` silently fell back to `{}` (everything rendered Italian) and i18n tests failed with a confusing "after JSON" parse error. Repaired by merging the trailing key lines back inside the object.

**How to apply:** Any time keys are added, prefer inserting next to an existing sibling key inside the object, keep the three files key-consistent (tests enforce this), and validate JSON afterward.
