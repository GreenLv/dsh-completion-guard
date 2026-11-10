# Documentation / 文档索引

## Install and use Guard / 安装与使用

- [Installation and first load / 安装与首次载入](GETTING_STARTED.md) covers Web, Headless and Desktop, what to expect after startup, and how to change the default mode.
- [Session migration and rollback / 旧会话迁移与回退](ACTIVATION_MIGRATION.md) explains what to save before replacing DSH or Guard.
- [Host-lock setup and upgrades](HOST_LOCK_UPGRADE.md) covers the actual package and profile checks. [Compatibility](COMPATIBILITY.md) records the supported versions and platform limits.
- [Changelog](../CHANGELOG.md) · [中文更新日志](../CHANGELOG.zh-CN.md) · [Package sources and community listings](distribution.md)
- [Privacy and stored data](PRIVACY.md) · [Third-party licenses](THIRD_PARTY_LICENSES.md)

## Maintain and validate Guard / 维护与验证

- [Architecture](ARCHITECTURE.md) explains how Guard follows a session and checks completion. The [writer-lock protocol](WRITER_LOCK_PROTOCOL.md) covers private record writes and downgrade precautions.
- [Acceptance records](LOCAL_ACCEPTANCE.md) distinguish source checks, CI, runs on the exact package, and public release readback. See also [historical incident coverage](HISTORICAL_INCIDENT_COVERAGE.md), [UI performance checks](UI_PERFORMANCE.md), and the [dependency advisory gate](DEPENDENCY_SCAN.md).
- [Semantic compatibility](SEMANTIC_COMPATIBILITY.md) compares Guard with Codex Context Guard. See the [core alignment contract](CORE_ALIGNMENT_CONTRACT_V2.md), [upstream starting point](UPSTREAM_BASE.md), and [porting notes](PORTING_NOTES.md) for the shared files and host-specific behavior.

### Local development

Use the Node.js minimum in `package.json`. Install the main dependencies and the isolated host fixture, then check the source and package.

```sh
pnpm install --frozen-lockfile
pnpm --dir tests/fixtures/host-composition install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run test:release-pack
pnpm run test:stats
pnpm run build
pnpm run pack:check
```

The repository's `AGENTS.md` describes the documentation and generated-runtime checks for a candidate. Local checks do not establish that an installed app loaded the plugin.

## Historical records / 历史记录

- [Development plans and release-note drafts at their original revisions](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/docs/README.md#historical-development-material)
- [0.8.3 performance development report](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/IMPLEMENTATION_RESULT_0_8_3_RUNTIME_PERFORMANCE.md). The handoff JSON mentioned there was not tracked in this repository.
- [Historical push-prohibition defect and regression](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/CONTEXT_GUARD_FINDING_negative-instruction-as-push.md)
- [0.6.3 contract revision](CONTRACT_REVISION_0_6_3.md) and [cross-end result contract](CROSS_END_RESULT_CONTRACT.md) define terms used by the compatibility and regression records.
