---
name: demo
description: "Fixture skill used by skillcheck's own lint tests. Use only inside this repository's tests; it does nothing useful."
---

# demo

A clean fixture: frontmatter matches the directory, the description is
non-empty, and the relative link below resolves.

See [the reference](reference.md) and the [anchor](#demo). External links such
as [uinaf](https://uinaf.dev) are not resolved.

```md
[this link is inside a fence and is never linted](nowhere.md)
```

An inline `[code span link](nowhere.md)` is not linted either.
