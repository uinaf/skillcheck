---
name: hidden-demo
description: "Fixture skill that is explicit-invoke only. Use only inside this repository's tests."
disable-model-invocation: true
---

# hidden-demo

Covers the bare-boolean `disable-model-invocation` case: the lint accepts the
literal `true` and rejects a quoted string.
