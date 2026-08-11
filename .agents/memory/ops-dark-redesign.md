---
name: Operations dark redesign scoping
description: Scope decision for the graphite "control center" theme on Operations Tasks & Calendar.
---

The dark graphite theme is opt-in per page: it only applies where a dedicated body class activates a fully namespaced stylesheet, and the Calendar page keeps its styles self-contained inline.

**Why:** PlateTimer Service must stay pixel-identical and the other Operations pages were explicitly out of redesign scope, so global or shared selectors must never carry theme changes.

**How to apply:** when extending the dark identity to another Operations page, opt that page in via the scoped body class + namespaced stylesheet; never restyle generic selectors in the shared Operations stylesheet.
