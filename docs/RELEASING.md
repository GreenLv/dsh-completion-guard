# Preparing a Release

GitHub Release titles use **`DCG <version>`**, for example `DCG 0.13.2` or
`DCG 0.14.0-rc.1`. Keep the full version and put feature summaries in the body.
The Git tag remains `v<version>`; the package identity is `dsh-completion-guard`.

## Write the two changelog entries

Add the new version at the top of both changelogs using a plain `## <version>`
heading. Use these sections in order:

| File | Changes | Upgrade guidance |
| --- | --- | --- |
| `CHANGELOG.md` | `### Changes` | `### Upgrading` |
| `CHANGELOG.zh-CN.md` | `### 变更` | `### 升级步骤与兼容性` |

Start with what changes for users. Keep compatibility requirements, preserved
data, required upgrade steps, known risks and unverified cases explicit in each
language. The entries must agree on the preceding version.

## Generate and review the exact text

From the checkout, run:

```sh
pnpm run release:notes --output-dir <unused-directory-outside-repository>
```

The command reads the version from `package.json`. It writes:

- `release-notes.md`: the English Changes and Upgrading sections, followed by
  the Chinese sections, matching the established Release layout.
- `release-fields.json`: the exact `name` and `body` fields for publication.
- `release-notes.json`: version, preceding version, title, body digest and
  source changelog digests for review.

Relative links are pinned to the version tag. Each language ends with its
changelog and preceding-version comparison links. Missing entries, incomplete
sections, conflicting history or an existing output directory stop generation.
Use inline Markdown links, including angle-bracket destinations for paths with
spaces. Inline code and fenced examples are preserved literally. Reference-style
links are refused, including references defined outside the selected entry, so
the two languages cannot accidentally share a label. Use inline links instead,
and use fenced code for examples of link syntax.

For a correction to an existing Release, select its entry explicitly:

```sh
pnpm run release:notes --version 0.13.1 --output-dir <another-unused-directory>
```

Read both generated language blocks before publishing. The generator prepares
text; source, artifact, native acceptance and publication follow the separate
requirements in [AGENTS.md](../AGENTS.md). Its regression tests run through
`pnpm run test:release-pack`, including the existing CI static-contract job.

## Correct an existing display title or body

Record the current Release ID, text, tag target, flags, publication time and
assets first. Send only the intended `name` and/or `body` fields, then read
back the Release independently. Verify those exact fields and confirm the tag,
assets and publication state still match the original. A display correction
does not change the previously published package or establish new acceptance.
