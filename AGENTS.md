# Project Instructions

- Versions use CalVer `YY.MM.PATCH`. Example: after `26.8.0`, another August 2026 release is `26.8.1`; `26.9.0` is a September 2026 release.

- Use the root Prettier setup for code formatting. From the repository root, run `npm run format -- <changed-files>` and verify with `npm run format:check -- <changed-files>`. Keep formatting scoped to files you change; respect `.prettierignore` and do not reformat unrelated packages or vendored code.

- Write only necessary tests protecting critical behavior or concrete regressions. Reuse existing coverage; avoid redundant tests, implementation-detail assertions, and brittle snapshots. Every new test must catch a meaningful failure existing tests miss.
