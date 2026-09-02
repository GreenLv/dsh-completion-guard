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

## Incomplete v0.3.0 identity

`dsh-completion-guard@0.3.0` is publicly readable from npm and its tarball
passed same-byte native macOS and Windows validation. The registry metadata
omits the release contract's required `gitHead`, however, so `v0.3.0` is not
listed as a completed destination and has no GitHub Release. The immutable npm
version and annotated tag are retained for audit history; the npm version is
deprecated with `Release metadata incomplete; use dsh-completion-guard@0.3.1.`
Version 0.3.1 repairs the provenance-bearing frozen-package workflow.

## Published v0.4.0 destinations

1. [GitHub Release `v0.4.0`](https://github.com/GreenLv/dsh-completion-guard/releases/tag/v0.4.0)
   is the latest non-draft, non-prerelease release. Its annotated tag peels to
   release commit `d5cd0ca17833d05bfdf41457ae203864bde8056b`. The Release
   carries the frozen tgz, checksum, artifact manifest, and separate macOS and
   Windows native-acceptance annexes. The tgz has SHA-256
   `71ce205dedeffe72566ad399e001f0b337d057cede297e1d2249acec67cde1f2`.
2. [`dsh-completion-guard@0.4.0` on npm](https://www.npmjs.com/package/dsh-completion-guard/v/0.4.0)
   is published and `latest` resolves to `0.4.0`. The registry `gitHead`
   equals the release commit, and a fresh registry download is byte-identical
   to the frozen Release tgz.
3. Source commit, candidate/main/tag CI, native macOS and Windows acceptance,
   npm metadata and bytes, and all five GitHub assets are reconciled in
   [`docs/LOCAL_ACCEPTANCE.md`](LOCAL_ACCEPTANCE.md).

## Earlier v0.3.2 destinations

1. [GitHub Release `v0.3.2`](https://github.com/GreenLv/dsh-completion-guard/releases/tag/v0.3.2)
   remains a non-draft, non-prerelease historical release. Its annotated tag peels to
   release commit `22cde6106cdca511265bb4103375a263a0762b9c`. The attached
   frozen tgz has SHA-256
   `feb7fc29799820e08dfe6d2bdb94823e745df9b5aa7c34d46262e5df30dabac4`;
   the separate `SHA256SUMS.txt` asset binds the same bytes.
2. [`dsh-completion-guard@0.3.2` on npm](https://www.npmjs.com/package/dsh-completion-guard/v/0.3.2)
   is published and `latest` resolves to `0.3.2`. The registry `gitHead`
   equals the release commit, and a fresh registry download is byte-identical
   to the frozen release tgz.
3. Source commit, tag, CI, native macOS and Windows acceptance, npm metadata
   and bytes, and both GitHub assets are reconciled in
   [`docs/LOCAL_ACCEPTANCE.md`](LOCAL_ACCEPTANCE.md).

## Earlier v0.3.1 destinations

1. [GitHub Release `v0.3.1`](https://github.com/GreenLv/dsh-completion-guard/releases/tag/v0.3.1)
   is published as a non-draft, non-prerelease release. Its annotated tag
   peels to release commit `00ed5c6456e15f0859c1ef7731157d07a3903af9`.
   The attached frozen tgz has SHA-256
   `df3c0cae29fdfa0014d5cfdb6ade72c42386555779f9f4d8b59e37a2557c5d7e`;
   the separate `SHA256SUMS.txt` asset binds the same bytes.
2. [`dsh-completion-guard@0.3.1` on npm](https://www.npmjs.com/package/dsh-completion-guard/v/0.3.1)
   is published and `latest` resolves to `0.3.1`. The registry packument
   `gitHead` equals the release commit above, and a fresh registry download is
   byte-identical to the frozen release tgz.
3. Source commit, tag, CI, native macOS and Windows acceptance, npm metadata
   and bytes, and both GitHub assets are reconciled in
   [`docs/LOCAL_ACCEPTANCE.md`](LOCAL_ACCEPTANCE.md).

## Earlier v0.2.1 destinations

The [v0.2.1 GitHub Release](https://github.com/GreenLv/dsh-completion-guard/releases/tag/v0.2.1)
and [`dsh-completion-guard@0.2.1`](https://www.npmjs.com/package/dsh-completion-guard/v/0.2.1)
remain publicly readable as historical identities. They are not the current
install target.

## Community indexes

| Channel | Entry | Status | Evidence |
|---|---|---|---|
| [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) | `GreenLv/dsh-completion-guard` (category `security`) | Listed | Added via [PR #3693](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/3693) (merge commit `299f0b5c`, 2026-08-29). The shorter plain-language English and Chinese descriptions merged via [PR #3977](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/3977) (merge commit `bdf5145`, 2026-09-01) and were read back from the current generated READMEs, source YAML, and public [`plugins.json`](https://awesome-dsh-plugin.com/plugins.json). The detail page still showed the earlier wording and GitHub install command at readback, so that page refresh remains pending. Screenshots are declared in this repository's [`screenshots.json`](../screenshots.json); image changes do not need a listing PR. |
| [dsh-market](https://dsh-market.com/) | `dsh-completion-guard` (Tools / Development workflow) | Listed | Added via [PR #1285](https://github.com/zhu1090093659/dsh-web/pull/1285) (merge commit `be426da`, 2026-08-31); read back on 2026-09-01 from the public [`manifest/plugins.json`](https://dsh-market.com/manifest/plugins.json) at rank 51. The market reads the listing text from its community index; npm download counts and likes are updated separately by the site. |
| [Awesome DeepSeek Harness](https://github.com/Dominic789654/awesome-deepseek-harness#security--permissions) | `GreenLv/dsh-completion-guard` | Listed | Rows merged via [PR #332](https://github.com/Dominic789654/awesome-deepseek-harness/pull/332) (merge commit `ba414c4`, 2026-08-29) and read back live the same day from both generated READMEs (`README.md` line 940, `README.zh-CN.md` line 946), under **Security & Permissions** alongside the other fail-closed gates and verifier plugins. |

## Update route

Directory entries resolve the npm `latest` tag or link the repository, so
routine releases refresh automatically. Row wording changes go through a pull
request against the listing repository. Historical acceptance evidence for
each release is kept in [`docs/LOCAL_ACCEPTANCE.md`](LOCAL_ACCEPTANCE.md).
