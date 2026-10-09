# Installation and first load / 安装与首次载入

[English README](../README.md) · [中文 README](../README.zh-CN.md)

## Before installation

Use the profile you actually run: Web, Headless or Desktop. Stop the relevant host/session writers first. If this installation has old Guard sessions, preserve the old package and effective mode sources, then prepare a frozen inventory and migration receipt using [the migration guide](ACTIVATION_MIGRATION.md) **before replacing DSH or Guard**. Empty old sessions count too. The 0.9.0 migration toolkit can run from a separately prepared package directory while the old package stays installed.

With no old Guard sessions, there is no old-mode adoption step. Upgrade the host to DSH `>=0.2.0-rc.2` if necessary, install Guard, and complete the installation checks before startup. Requires Node.js `>=22`, pnpm `>=11` and a qualified Cordis `>=4.0.4` installation. Do not load both `dsh-context-guard` and `dsh-completion-guard` in one profile; the internal entry ID remains `context-guard`.

## 安装前

先确认实际使用的 Web、Headless 或 Desktop profile，并停止相应宿主与会话写者。如果已有旧 Guard 会话，替换 DSH 或 Guard **之前**，按[迁移指南](ACTIVATION_MIGRATION.md)保留旧包、核验有效模式来源，冻结会话库存并准备迁移收据。旧空会话也需要清点。0.9.0 迁移工具可以从另行准备的包目录运行，旧包此时仍留在原安装位置。

没有旧 Guard 会话时，不需要旧模式 adoption。先按需将 DSH 升级到 `>=0.2.0-rc.2`，再安装 Guard，完成安装核验后启动。需要 Node.js `>=22`、pnpm `>=11` 及通过资格验证的 Cordis `>=4.0.4`。同一 profile 不要同时加载 `dsh-context-guard` 和 `dsh-completion-guard`，内部条目 ID 仍是 `context-guard`。

## Web installation / Web 安装

Keep the host stopped through these steps. Substitute the actual absolute runtime/profile paths. Back up the profile's `cordis.patch.yml` before `inject`, which writes the lock into that file. The three host-lock checks—`inspect`, `inject` and `verify-dump`—must each return `status: "supported"`; a nonzero exit or another status stops this path. This status requirement does not apply to `dsh plugin add`.

以下步骤期间保持宿主停止，将目录替换为实际绝对路径。`inject` 会把锁写入 profile 的 `cordis.patch.yml`，执行前先备份。`inspect`、`inject` 和 `verify-dump` 三条宿主锁检查都须返回 `status: "supported"`；非零退出或其他状态都不能继续启动。该状态要求不适用于 `dsh plugin add`。

```sh
dsh plugin --profile web add dsh-completion-guard@0.9.0

DSH_RUNTIME_ROOT=/absolute/path/to/.dsh-runtime
DSH_PROFILE_ROOT=/absolute/path/to/.dsh/profiles/web
GUARD_HOST_LOCK="$DSH_PROFILE_ROOT/node_modules/.bin/dsh-completion-guard-host-lock"

"$GUARD_HOST_LOCK" inspect --runtime-root "$DSH_RUNTIME_ROOT" --profile-root "$DSH_PROFILE_ROOT"
"$GUARD_HOST_LOCK" inject --runtime-root "$DSH_RUNTIME_ROOT" --profile-root "$DSH_PROFILE_ROOT"
dsh --profile web --dump-config | "$GUARD_HOST_LOCK" verify-dump --runtime-root "$DSH_RUNTIME_ROOT" --profile-root "$DSH_PROFILE_ROOT" --dump-config -
```

The reviewed baseline is DSH `0.2.0-rc.2` / Cordis `4.0.4`. A later compatible host requires `--rebind-registry` on the three lock commands; it checks official archives and qualifies changed programs before rebuilding the lock. See [compatible-version rebinding](HOST_LOCK_UPGRADE.md#rebinding-compatible-package-versions). Changes to DSH, Guard or the profile location require fresh checks. An ordinary market-only update does not require reinjection; installing or removing the Desktop market does.

已审查基线为 DSH `0.2.0-rc.2` / Cordis `4.0.4`。更新的兼容宿主需要在三条锁命令中添加 `--rebind-registry`，核对官方归档并验证变化的程序后重建锁，见[兼容版本重绑定](HOST_LOCK_UPGRADE.md#rebinding-compatible-package-versions)。DSH、Guard 或 profile 路径变化后需要重新检查。仅 market 的普通更新不需重新注入，Desktop 市场的安装或移除则需要。

### Windows, Headless and Desktop / 其他入口

- **Windows Web:** run the same lock subcommands through `node_modules\.bin\dsh-completion-guard-host-lock.cmd` inside the actual Web profile directory, with Windows absolute paths. Use your shell's variable syntax; the block above is POSIX shell syntax.
- **Headless:** use the Headless profile and its own installed lock tool throughout, including `--profile headless` on DSH commands. See [the host-lock guide](HOST_LOCK_UPGRADE.md) for the profile-specific flow.
- **Desktop:** use the app's bundled CLI for installation and `--profile desktop` when building the lock. Bind the app archive and actual Desktop profile. Its CLI has no `--dump-config`; run `dump-desktop` and verify that newly generated output. The complete commands are in [official Desktop setup](HOST_LOCK_UPGRADE.md#official-desktop-profile). After installing or removing `dshmarket`, repeat `inspect`, `inject`, `dump-desktop` and `verify-dump` on the new output.

中文对应路径：

- **Windows Web：**通过实际 Web profile 下的 `node_modules\.bin\dsh-completion-guard-host-lock.cmd` 运行相同锁子命令，使用 Windows 绝对路径和当前 shell 的变量语法；上方示例是 POSIX shell。
- **Headless：**全程使用 Headless profile 及其安装的锁工具，DSH 命令选择 `--profile headless`，完整流程见[宿主锁指南](HOST_LOCK_UPGRADE.md)。
- **Desktop：**使用应用附带 CLI 安装，以 `--profile desktop`、应用归档和实际 Desktop profile 建锁。该 CLI 没有 `--dump-config`，要用 `dump-desktop` 生成新配置，再核验这份输出。[官方 Desktop 步骤](HOST_LOCK_UPGRADE.md#official-desktop-profile)给出完整命令。安装或移除 `dshmarket` 后重新执行 `inspect`、`inject`、`dump-desktop`，并对新输出执行 `verify-dump`。

## Finish an upgrade before startup

A host lock verifies the installation, not old session modes. While writers remain stopped, use the frozen pre-upgrade receipt for `adopt` and `verify`. Start the host only after installation/lock checks and the intended migration scope pass. Unknown old sources, missing bindings and conflicts stay pending; do not fill them with the upgraded `always` default.

If the official persistence reader refuses old formats, preserve those logs and mode sources. The [readable-subset flow](ACTIVATION_MIGRATION.md) freezes the whole report, then a user-reviewed selection of exact readable IDs. All three migration commands carry the same `--selection`; exclusions remain pending even when selected rows succeed. A zero exit or `selected_complete` does not establish whole-inventory completion. Corruption, permissions and other errors abort rather than becoming exclusions. The guide also contains [copyable migration prompts](ACTIVATION_MIGRATION.md) and recovery steps.

## 升级核验完成后再启动

宿主锁核验安装环境，不会迁移旧会话模式。保持写者停止，用升级前冻结的收据完成 `adopt` 和 `verify`。安装、锁核验及目标迁移范围全部通过后才能启动；旧来源未知、绑定缺失或冲突时保持待处理，不能用升级后的 `always` 默认值填补。

官方 persistence 若拒绝旧格式，保留原日志和模式来源。按[可读子集流程](ACTIVATION_MIGRATION.md)先冻结全库报告，再明确选择精确的可读 ID。三个迁移命令都携带同一 `--selection`，选中行通过后排除项仍待处理。零退出或 `selected_complete` 不代表整库完成；损坏、权限等其他异常会中止，不会转成排除项。指南还提供[可复制迁移提示词](ACTIVATION_MIGRATION.md)和恢复步骤。

## First load and status

When you open or restore a session that already has history, DSH loads that history and Guard reconstructs its saved state. You may see “载入历史” (loading history); wait for loading to finish before continuing. A later visit can still wait.

0.9.0 reuses completed history checks only when it can verify that the history is unchanged and the results are safe to reuse. Each operation still checks the current mode and performs the required fresh checks of Goal state, private records and the host environment. It does not modify the official host's history-view lifecycle or decode cache and does not guarantee an instant first opening or subsequent visit.

Once loading finishes, run `/context-guard status`. A new empty root session normally reports `armed`, waiting for the first real input; Guard has written no session events yet. DSH may have written its own initialization events. Images and attachments count as real input, blank messages do not. In an old session, check the retained mode and any binding diagnosis. Protection does not grant new authority, and the policy remains `standard`.

## 首次载入与状态

打开或恢复已有历史的会话时，DSH 载入历史，Guard 重建已保存的状态。界面可能显示“载入历史”，等加载结束后再继续；再次进入也可能需要等待。

0.9.0 只在确认历史未变、检查结果可安全复用时，复用已经通过的历史检查。每次操作仍核对当前模式，并按需要重新核验 Goal 状态、私有记录和宿主环境。它没有修改官方宿主的历史视图生命周期或解码缓存，不能保证首次或后续打开立即完成。

加载结束后执行 `/context-guard status`。新建空根会话通常显示 `armed`，等待首条真实输入，此前 Guard 没有写入会话事件；DSH 可能已记录自身的初始化事件。图片、附件算真实输入，纯空白不算。旧会话查看保留模式和可能的绑定诊断。保护不增加权限，策略仍为 `standard`。

## Choose the default for new sessions

Profiles that omit `activation` already use `always` for new roots. If your profile explicitly selects `opt-in`, change only `activation` in its existing `context-guard` entry. Keep injected host-lock fields; this is a field illustration, not a replacement for the whole configuration. Existing session bindings remain authoritative. Contradictory explicit configuration reports `activation_mode_conflict` rather than replacing a bound mode.

## 新会话默认模式

profile 未填写 `activation` 时，新建根会话已默认采用 `always`。若显式填写了 `opt-in`，仅修改原 `context-guard` 条目中的 `activation`，保留注入的宿主锁字段。下方只展示要改的字段，不能替换完整配置。旧会话仍按已有绑定恢复；显式配置矛盾时报告 `activation_mode_conflict`，不会覆盖模式。

```yaml
- id: context-guard
  name: dsh-completion-guard
  config:
    activation: always
```

Default settings paths / 默认配置路径：

| System / 系统 | Profile | Settings / 配置 |
| --- | --- | --- |
| macOS / Linux | Web | `$HOME/.dsh/profiles/web/cordis.patch.yml` |
| macOS / Linux | Headless | `$HOME/.dsh/profiles/headless/cordis.patch.yml` |
| macOS | Desktop | `$HOME/.dsh/profiles/desktop/cordis.patch.yml` |
| Windows | Web | `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` |
| Windows | Headless | `%USERPROFILE%\.dsh\profiles\headless\cordis.patch.yml` |
| Windows | Desktop | `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` |

Use a custom `DSH_HOME` instead of the default `.dsh` directory when configured. Restart the appropriate host after the edit, once the required lock and migration checks have passed. Guard `on`/`off` controls this session's protection, not its DSH standard/minimal/custom preset.

设置了自定义 `DSH_HOME` 时，使用该目录而非默认 `.dsh`。修改后在必要的锁及迁移核验通过时重启相应宿主。Guard 的 `on`、`off` 控制当前会话保护，不改变 DSH 的标准、极简或自定义 preset。

Copyable configuration prompt / 可复制配置提示词：

> Set the default for new root sessions in dsh-completion-guard to always. Preserve existing session bindings. Find the cordis.patch.yml for the Web, Headless or Desktop profile I actually use, back it up and change only activation on the context-guard entry. Preserve all other settings and host-lock fields. Do not restart DSH. Show the path and exact diff, and report whether lock or migration checks remain before restart.

> 将 dsh-completion-guard 后续新根会话的默认模式设为 always，保留旧会话绑定。找到我实际使用的 Web、Headless 或 Desktop profile 的 cordis.patch.yml，先备份，只修改 context-guard 条目的 activation，保留其他配置和宿主锁字段。不要重启 DSH；报告文件路径、精确差异，以及重启前是否还有锁或迁移核验未完成。
