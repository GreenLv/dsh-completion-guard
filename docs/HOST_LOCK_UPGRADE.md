# Upgrading the core host lock

Version 0.9.0 requires DSH `>=0.2.0-rc.2` and qualified Cordis `>=4.0.4`. Fresh installations have no old-mode inventory to adopt; existing installations must preserve their old mode sources before any replacement. Follow this order:

1. Stop the relevant host/session writers. For an **existing installation**, preserve the old installed package and sanitized effective-mode sources, then prepare the public persistence inventory and frozen receipt with the [prepared-candidate migration toolkit](ACTIVATION_MIGRATION.md), **before replacing DSH or Guard**. Unresolved old provenance stays pending. A **fresh installation with no old Guard sessions** skips this old-mode preparation.
2. Upgrade DSH to `0.2.0-rc.2` or a later version, then install this Guard version, keeping writers stopped.
3. Rebuild the host lock for each profile with `inspect`, `inject` and `verify-dump` from the accepted package or matching prepared source. For a POSIX shell, the entry is `node /absolute/prepared-package/bin/dsh-completion-guard-host-lock.mjs`; pass the actual runtime/profile roots. A successful rebuild reads back `supported` with `audit_provenance` stating how the graph was established.
4. For an **existing installation**, run mode `adopt` and `verify` with its frozen old receipt while writers remain stopped, **before starting any host**. Host-lock rebuilding does not perform adoption. For a fresh installation there is no old receipt to adopt.
5. Start each Web/Headless/Desktop profile only after the applicable mode and host-lock checks pass. These checks do not require a running host.

0.9.0 的全新安装没有旧模式需要采纳；已有安装必须在替换前保留旧来源。顺序为：先停相关写者，保存旧安装包和脱敏有效模式来源，以独立准备的候选工具冻结公开库存及旧收据；再升级 DSH、安装 Guard、重建宿主锁；保持写者停止，在启动任何宿主前完成旧收据 `adopt` 和 `verify`；最后按需启动。全新安装跳过旧模式准备与 adoption，未知旧来源仍保持 pending，宿主锁不替代模式核验。

Failure readbacks distinguish these cases:

- `host_lock_migration_required`: the configuration lacks the policy or source roots. Supply `--runtime-root` and `--profile-root` when rebuilding the lock.
- `host_lock_version_below_minimum`: DSH is older than `0.2.0-rc.2`. Upgrade DSH first.
- `host_lock_version_mismatch`: the installed graph differs from the reviewed baseline in version or integrity. For a later compatible version, use `--rebind-registry` to acquire and qualify the published graph. For the baseline, restore the recorded identities.
- `host_lock_installed_graph_drift`: installed bytes or routes changed after the audit. Inspect the change before rebuilding the lock.

The floor is `>=0.2.0-rc.2` with no upper bound. Passing the version check does not establish native validation; validated versions are recorded separately. Guard's exact DSH core is separate from optional market versions.
A normal market update no longer changes the core digest. A plugin that changes
which core packages actually resolve still invalidates the lock.

## Upgrade an existing profile

Choose the published Guard package and DSH version from the
[compatibility guide](COMPATIBILITY.md). Keep the existing profile backup and
its disabled/activation settings. Before replacing either DSH or Guard, stop writers and preserve the old package/effective-mode sources and frozen inventory/receipt as above. After replacement, adopt and verify that receipt before startup. Installation does not authorize enablement.
Web and Headless are separate profiles and must be checked separately.

If the profile still declares `dsh-context-guard`, replace it through DSH's
plugin manager rather than loading both package names. Its internal
`context-guard` id remains unchanged. Preserve session files and user settings;
if a profile override names the old package, change only that package name.
Headless does not need market added as part of this migration.

After the new package is installed, use absolute paths for the actual runtime
and profile. The following example targets a POSIX shell:

```sh
DSH_RUNTIME_ROOT=/absolute/path/to/.dsh-runtime
DSH_PROFILE_ROOT=/absolute/path/to/.dsh/profiles/web
GUARD_HOST_LOCK="$DSH_PROFILE_ROOT/node_modules/.bin/dsh-completion-guard-host-lock"
"$GUARD_HOST_LOCK" inspect --runtime-root "$DSH_RUNTIME_ROOT" --profile-root "$DSH_PROFILE_ROOT"
"$GUARD_HOST_LOCK" inject --runtime-root "$DSH_RUNTIME_ROOT" --profile-root "$DSH_PROFILE_ROOT"
dsh --profile web --dump-config | "$GUARD_HOST_LOCK" verify-dump --runtime-root "$DSH_RUNTIME_ROOT" --profile-root "$DSH_PROFILE_ROOT" --dump-config -
```

**Run this block after the runtime is already on the target DSH version, not
before.** `inject` records the absolute runtime and profile roots and binds the
graph it finds there, and each session mount validates those same roots once,
with every security-sensitive entry validating them again at its own decision.
Injecting against the old runtime therefore writes a lock that describes a graph
the new runtime no longer has, and it will fail at the next mount or the next
protected entry. Order: stop the host, upgrade DSH and install Guard, inspect/inject/verify each profile, then start it when needed.

`inject` **writes to `<profile>/cordis.patch.yml`** — it replaces or adds Guard's
managed block in that file. Back the file up first. The same file is the one
`docs/LOCAL_ACCEPTANCE.md` tells you to preserve.

**Check both the JSON verdict and the exit status.** Accepted commands print `status: "supported"`. A missing graph, drift, incompatible implementation or untrusted registry description reports a specific `reason_code` on stderr and exits 1. `inspect-graph` is a pre-install graph check; it does not grant runtime authority.

For Headless, use its profile path for the host-lock commands and `dsh --profile headless --dump-config` for the dump. On Windows, use the
installed `.cmd` launcher and Windows absolute paths. A strict repeat leaves
the package and profile contents unchanged. Restarting or enabling a daily
profile remains a separate user action.

## Check a Headless profile before installation

A DSH Headless profile can have no external dependencies and no private `node_modules` or lockfile. From an accepted package or matching source checkout, `node bin/dsh-completion-guard-host-lock.mjs inspect-graph --runtime-root <runtime> --profile-root <profile>` checks that state without initializing or launching the profile.

This narrow case requires the installation-owned `dsh-base` and `dsh-headless` bundles, with the RC.2 `dsh-web-app` bundle allowed between them, a complete audited runtime core, and matching bundle versions, package-map origins and patch files. Declared but uninstalled dependencies, partial map/lock pairs, unexplained local modules and foreign parent-module fallbacks are rejected. Existing profiles with both graph files retain their active-importer checks; damaged files are not treated as an empty graph.

The result labels `inspection_scope: pre_install_target` and `profile_graph.state: dependency_free_headless`, with the manifest hash and bundle identities. Its package rows describe the verified runtime core used for this installation target, not a private profile importer or a live boot. After installing Guard, the `inspect`, `inject` and runtime replay checks still require the profile's package map, lockfile and installed plugin binding. This pre-install result cannot replace those checks.

## What changes in the lock

The generator writes `hostLockPolicy: dsh-core/v1`, the actual runtime/profile
source roots, platform/profile kind and the actual core package graph (46 rows in the reviewed baseline). The
core manifest is version 2. Each session mount validates those graph sources
exactly once; ordinary replay (resume, compaction, step and command refresh)
consumes that result without rescanning, and every entry that grants
certificate authority — completion certificates, mutation authorization,
release pre-effect decisions and Goal/Stop boundaries — validates the lock
freshly at the moment of its own decision.

Version 0.9.0 registers `dsh-0.2.0-rc.2-core-v1` as the audited baseline cohort and derives graph cohorts for compatible hosts above the version floor (see the compatibility guide). Runtime checks authenticate the mapped files and verify that each critical dependency resolves to the mapped instance. Installation imports use native Node resolution; Profile imports use the host's local-first routing and installation fallback only when no local package is selected. A nearer shadow, missing edge, wrong export target or escaped path is rejected even when the recorded versions match.

The manifest's `registry-derived-pending-native-audit` provenance and empty `auditedPlatforms` list describe its immutable source audit, which is part of the lock digest. Native acceptance belongs to each exact artifact's separate Release annexes; it does not rewrite that digest. Inspection, injection and dump verification report `audit_provenance` alongside the cohort and digest.

**Which failure code you see depends on the lock generation you are holding**, and
that matters for deciding whether you are migrating or just drifting:

- A **pre-0.4.3** lock — no `hostLockPolicy: dsh-core/v1`, or no recorded
  runtime/profile roots — reports `host_lock_migration_required`. Removing its
  market row by hand is not migration. Reinspect, inject and verify the actual
  environment.
- A **0.4.3-or-later** lock already carries the policy and the roots, so it never
  reports `host_lock_migration_required`. It reports the mismatch instead:
  `host_lock_version_mismatch` when the installed core package versions differ from
  the cohort, or `host_lock_installed_graph_drift` when the re-read graph resolves
  to a different digest than the lock recorded. Both are the expected answers after
  a DSH upgrade, and both are cured by re-running inspect, inject and verify against
  the new runtime rather than by editing the lock.

Historical requirements and session records are retained; old certificates do not become certificates for the new lock. Historical host cohorts are test data only and are not accepted by 0.9.0.
The shared digest-v3 encoder and its upstream fixtures are unchanged.

## Official Desktop profile

Stop the Desktop app before installing or rebuilding its lock. Use the CLI carrier shipped with that app: `Contents/Resources/runtime/cli/bin/dsh` on macOS, or `resources\runtime\cli\bin\dsh.cmd` in the Windows installation. A separately installed `dsh` CLI cannot manage the reserved Desktop profile.

For an existing installation, first preserve the old package/effective modes and freeze the inventory/receipt before replacing the carrier or Guard; after replacement, complete adoption/verification before Desktop startup. For a fresh installation there is no old-mode adoption. Install Guard through that carrier with `plugin --profile desktop add dsh-completion-guard@0.9.0`. Use the profile's own host-lock tool and the app's physical `app.asar` as `--runtime-root`. The default profile is `$DSH_HOME/profiles/desktop`, or `.dsh/profiles/desktop` under the user's home when `DSH_HOME` is unset. This POSIX example starts after installation:

```sh
DSH_DESKTOP_ASAR=/absolute/path/to/DeepSeek-Harness.app/Contents/Resources/app.asar
DSH_DESKTOP_PROFILE=/absolute/path/to/.dsh/profiles/desktop
GUARD_DESKTOP_LOCK="$DSH_DESKTOP_PROFILE/node_modules/.bin/dsh-completion-guard-host-lock"
"$GUARD_DESKTOP_LOCK" inspect --profile desktop --runtime-root "$DSH_DESKTOP_ASAR" --profile-root "$DSH_DESKTOP_PROFILE"
"$GUARD_DESKTOP_LOCK" inject --profile desktop --runtime-root "$DSH_DESKTOP_ASAR" --profile-root "$DSH_DESKTOP_PROFILE"
"$GUARD_DESKTOP_LOCK" dump-desktop --profile desktop --runtime-root "$DSH_DESKTOP_ASAR" --profile-root "$DSH_DESKTOP_PROFILE" > desktop-composed.yml
"$GUARD_DESKTOP_LOCK" verify-dump --profile desktop --runtime-root "$DSH_DESKTOP_ASAR" --profile-root "$DSH_DESKTOP_PROFILE" --dump-config desktop-composed.yml
```

On Windows use the `.cmd` host-lock launcher and the installation's `resources\app.asar` path. `dump-desktop` authenticates the carrier and uses the app's bundled configuration APIs to compose the same bundle/profile/home layers, without starting a host. It writes the profile's empty loader anchor as the official dump API does. Preserve any composed output privately because user configuration may contain secrets; it is not a Release attachment.

Check `supported` on inspect, inject and verify-dump. Keep Desktop stopped until all checks pass, then open the app when needed. Guard never edits the app archive or restarts the graphical app.

The official plugin market (`dshmarket`) can be installed into the same Desktop profile through the official management entry; its package name neither conflicts with the Desktop bundle tuple nor grants any trust. Installing or removing the market changes the profile's importer, so the previous Desktop lock stops matching (`host_lock_installed_graph_drift`) and must be rebuilt with the full four-step flow: `inspect`, then `inject`, then generate a NEW composed dump with `dump-desktop`, then verify that new dump with `verify-dump --dump-config <new file>`. `dump-desktop` only composes a configuration for readback; it never substitutes for `verify-dump`. Verify the dump generated after this rebuild — a dump captured before the market change no longer matches and must be discarded. Rebuild the lock on this machine; a lock or digest copied from another profile or machine is not valid evidence. Desktop restart stays unsupported regardless of coexistence.

Desktop 升级顺序相同：先停止应用并升级宿主，再用应用附带的 CLI 安装 Guard。普通外部 CLI 无法管理保留的 Desktop profile。以应用的 `app.asar` 和实际 Desktop profile 路径执行 `inspect`、`inject`、`dump-desktop`、`verify-dump`，确认三项 JSON 回读均为 `supported` 后再打开应用。`dump-desktop` 不启动宿主；配置输出可能包含私人信息，请留在本机。Guard 不修改应用归档，也不负责应用重启。官方插件市场（`dshmarket`）可以通过官方管理入口安装到同一 Desktop profile；其包名既不与 Desktop bundle 元组冲突，也不授予任何信任。安装或移除市场会改变 profile 的 importer，旧 Desktop 锁因此不再匹配（`host_lock_installed_graph_drift`），需要用完整四步流程重建：先 `inspect`，再 `inject`，然后用 `dump-desktop` 生成新的组合配置，最后用 `verify-dump --dump-config <新文件>` 校验这份新配置。`dump-desktop` 只负责生成配置供回读，不能替代 `verify-dump`。请校验本次重建后新生成的 dump——市场变化前捕获的旧 dump 已不匹配，应当丢弃。请在本机重建锁；从其他 profile 或其他机器复制的锁或摘要不构成有效证据。无论是否共存，Desktop 重启仍不受支持。

## Market and restart

Core compatibility does not certify the optional market restart adapter.
Market's current HTTP capability response and a matching disk manifest cannot
prove which provider bytes the service has loaded. Current DSH provides no
independent loaded-instance verifier, so this adapter remains unavailable.
An explicit restart requirement stays pending with a binding-unavailable
reason. Other guarded work continues; package apply proves disk state only.

A trusted embedding can supply a loaded-instance verifier to the version-2
service adapter. Its provider identity binds the actual version, integrity,
loaded tree, profile, origin and protocol. Its instance identity additionally
binds the process and boot. Only a persisted restart intent may connect the
expected old instance to a verified new instance of the same provider.
Provider replacement, arbitrary process drift and old version-1 credentials
cannot close that intent. These checks do not isolate a process from a
concurrently malicious process running as the same user.

## Acceptance records

Use the [native entrypoint](LOCAL_ACCEPTANCE.md) with explicit core targets
and a Web market version. Supplied daily target paths are read-only preflight
inputs. The driver creates its own isolated profiles, with no market in
Headless. Real market HTTP lifecycle checks and protocol unit fixtures are
separate from Guard adapter certification. Each native annex belongs to one
exact artifact and platform; publication is recorded on its GitHub Release.

## Historical 0.5.1 evidence

Version 0.5.1 registered DSH `0.1.5-rc.1` and `0.1.5-rc.2` with 33 critical packages. Its macOS and Windows results belong only to that artifact and those hosts; see the [0.5.1 release annexes](https://github.com/GreenLv/dsh-completion-guard/releases/tag/v0.5.1). These are historical records, not installation targets for 0.9.0.

## Rebinding compatible package versions

For a newer compatible installation, add `--rebind-registry` to `inspect-graph`, `inspect`, `inject` and `verify-dump` in the upgrade example above. This acquires the exact official archives and qualifies their consumed API contract. Changed programs run bounded probes in an isolated Node process; the command does not start DSH or install packages. A successful result binds a new lock. Keep the backup until dump verification succeeds.

The version floor admits later releases and RCs by SemVer precedence. A new version does not by itself prove that Guard can read its events or authorize its effects. Rebinding separates published installation identity from adapter qualification:

- Published identity is acquired from the official npm registry for each exact installed `name@version`. The registry integrity must agree with the installed lock, and the downloaded archive must reproduce that integrity. The archive supplies the manifest and module digests; local manifests and local lockfile SRI alone never establish provenance.
- Qualification is independent of version rows. Comments and formatting can retain reviewed program identity; unrelated unconsumed modules are allowed. Equivalence also checks ordered entry-selection fields and the consumed dependency graph. Changing `exports`, `main`, `imports` or an active dependency requires qualification of the actual selected entry, even when the old file remains intact. Changed programs must pass `guard-host-contract/v2` API and Session V4 behavior checks using actual bare package resolution in separate ESM/CJS Node processes. These check immutable, contiguous event snapshots, restore preservation/refusal, fork recovery and unknown tool outcomes, plus consumed service APIs. A contract failure refuses the affected implementation. Optional Goal failures disable Goal integration while independent core work remains available.
- The probe uses verified archives and exact installed dependency identities in a temporary directory. It receives no user environment or credentials, cannot write files or launch child processes, and has its network entrypoints disabled. It has bounded time/output and does not boot a host, run installation scripts or contact model providers. This is a finite contract check of official code, not certification of every possible host behavior.
- CJS and ESM behavior results are recorded separately. Critical adapter routes must agree on one authenticated target; auxiliary dependencies may use separately authenticated CJS/ESM files. When Node lacks ESM-through-`require` execution, CJS resolution is checked and its behavior remains explicitly unavailable.
- The generator stores a deterministic qualification receipt under the declared profile's `.dsh-completion-guard/host-contracts/` directory and puts its binding in managed configuration. The receipt binds exact package/module bytes and Node startup conditions; a package compatibility declaration or a descriptor without its issued receipt cannot establish qualification. Earlier v1 receipts are refused; run the same rebind commands to issue v2 receipts. Pre-install `inspect-graph` uses the same qualifier and byte/route audit. Inspection and authorization recheck the mixed-version graph, qualified bytes and both CJS/ESM routes in one fresh audit session; they do not repeat the behavioral probes.
- Route checks use actual startup conditions from command-line flags and `NODE_OPTIONS`, including custom conditions, disabled addons and `module-sync` availability. Changing these inputs creates a new binding. Custom loaders or ambiguous configuration are refused rather than approximated.
- A changed graph or trust description creates a new lock identity. Existing completion certificates and private authority records retain their old digest and cannot transfer. Reinject the lock, restart the profile under the user's control, and obtain new evidence.

Rebinding writes only its qualification receipt and, for `inject`, the managed lock configuration. It does not start DSH, install packages, publish, or mutate session history. Foreground/default-workdir interpretations retain their narrower reviewed-byte qualification. Native acceptance of a later DSH version remains separate from this source-level compatibility rule.

## 0.9.0 session modes / 会话模式

This is a major default-mode change for new root sessions only. Preserve old effective modes before replacing Guard, then use [activation inspect/adopt/verify](ACTIVATION_MIGRATION.md). Host-lock rebinding does not migrate modes or re-sign certificates. Existing bindings override defaults; explicit conflicts refuse. `standard` and persisted off/on retain their contracts. Missing modes remain unknown. Rollback and the current Windows storage capability gap are described in that guide.

本次只改变新建根会话的默认模式。更换 Guard 前保存旧有效模式，再按迁移说明清点、采纳及核验。重绑宿主锁不迁移模式、不重签证书；已有绑定覆盖缺省，显式冲突拒绝。standard 及持久化 off/on 合同不变，缺失模式保持 unknown，回退及 Windows 存储能力缺口见该说明。
