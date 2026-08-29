# Distribution status

This page records where `dsh-completion-guard` is published and independently
read back. Only verified, publicly live destinations are listed here; the
private submission pipeline and in-review entries are tracked outside the
repository and are intentionally not disclosed.

## Rename note (2026-08-29)

The project was renamed from `dsh-context-guard` to `dsh-completion-guard` to
avoid a name collision with an unrelated DeepSeek Harness plugin
(`kpl0111/dsh-context-guard`, a token-efficient tool-result pruning plugin
created 2026-08-16). The internal Cordis bundle id stays `context-guard`, so
installed profiles keep their runtime identity. The previous npm package
`dsh-context-guard` is deprecated across all published versions (0.1.0 –
0.2.1) with a pointer to this package.

## Published v0.2.1 destinations

1. [GitHub Release `v0.2.1`](https://github.com/GreenLv/dsh-completion-guard/releases/tag/v0.2.1)
   is published as a non-draft, non-prerelease release; the repository was
   renamed after tagging and the release URL follows the rename (old URLs
   301-redirect). The tag points at commit `ba8f05d`; the published npm
   artifact was built from `8497300`, whose dist is byte-identical to the
   gate build.
2. [`dsh-completion-guard@0.2.1` on npm](https://www.npmjs.com/package/dsh-completion-guard)
   is published and `latest` resolves to `0.2.1`. The registry packument
   `gitHead` equals the rename commit `8497300`, maintainer `greenlv`.
3. The committed `dist/` tree is byte-identical to the published npm tarball
   (verified 2026-08-29 by diffing the registry tarball against the local
   build; only `.DS_Store` is excluded and git-ignored).

## Community indexes

| Channel | Entry | Status | Evidence |
|---|---|---|---|
| [Awesome DeepSeek Harness](https://github.com/Dominic789654/awesome-deepseek-harness#security--permissions) | `GreenLv/dsh-completion-guard` | Listed | Rows merged via [PR #332](https://github.com/Dominic789654/awesome-deepseek-harness/pull/332) (merge commit `ba414c4`, 2026-08-29) and read back live the same day from both generated READMEs (`README.md` line 940, `README.zh-CN.md` line 946), under **Security & Permissions** alongside the other fail-closed gates and verifier plugins. |

## Update route

Directory entries resolve the npm `latest` tag or link the repository, so
routine releases refresh automatically. Row wording changes go through a pull
request against the listing repository. Historical acceptance evidence for
each release is kept in [`docs/LOCAL_ACCEPTANCE.md`](LOCAL_ACCEPTANCE.md).
