# Package sources and community listings

- [npm package](https://www.npmjs.com/package/dsh-completion-guard) shows the version offered by each npm distribution tag.
- [GitHub Releases](https://github.com/GreenLv/dsh-completion-guard/releases) lists the release notes and available assets.
- [Installation and first load](GETTING_STARTED.md) explains how to check the host version and verify the installed profile.

The project moved from `dsh-context-guard` to `dsh-completion-guard` on 2026-08-29 to avoid a name collision. The old npm package was deprecated. The internal plugin ID stayed `context-guard`. For existing sessions, follow the [migration guide](ACTIVATION_MIGRATION.md) before replacing an installation.

## Community listings

These entries were read back in September 2026. Each directory refreshes its own version and description, so its card can lag behind npm.

- [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) lists Guard under security.
- [dsh-market](https://dsh-market.com/) lists Guard under development workflow tools.
- [Awesome DeepSeek Harness](https://github.com/Dominic789654/awesome-deepseek-harness#security--permissions) lists Guard under security and permissions.

## Historical release identity

The npm package for `0.3.0` lacked the required `gitHead` field. The version was deprecated, and `0.3.1` repaired the workflow that records the source commit in the package.

The [original distribution readbacks](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/docs/distribution.md) record the older package versions, hashes, and listing observations as of their check dates. The [acceptance records](LOCAL_ACCEPTANCE.md) distinguish public package identity from tests in an installed host.
