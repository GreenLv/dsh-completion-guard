# dsh-completion-guard

[English](README.md)

面向 DeepSeek Harness（DSH）的任务保护插件。它保存任务要求，并在任务标记完成前逐项核对；会话恢复后仍使用同一份检查表，只有匹配的已保存工具结果才能作为证据。

![任务合同条款与有界证据通过 checkpoint 匹配后签发完成证书](assets/social/completion-guard-hero.png)

## 快速开始

将已发布插件安装到 DSH Web profile：

```sh
dsh plugin --profile web add dsh-completion-guard@0.4.0
```

重启 DSH 前，先记录并验证当前 runtime 和 profile。请把示例路径替换为本机绝对路径：

```sh
DSH_RUNTIME_ROOT=/absolute/path/to/.dsh-runtime
DSH_PROFILE_ROOT=/absolute/path/to/.dsh/profiles/web
DSH_COMPOSED_DUMP=/tmp/dsh-web-composed.yml
GUARD_HOST_LOCK="$DSH_PROFILE_ROOT/node_modules/.bin/dsh-completion-guard-host-lock"

"$GUARD_HOST_LOCK" inspect --runtime-root "$DSH_RUNTIME_ROOT" --profile-root "$DSH_PROFILE_ROOT"
"$GUARD_HOST_LOCK" inject --runtime-root "$DSH_RUNTIME_ROOT" --profile-root "$DSH_PROFILE_ROOT"
dsh --profile web --dump-config > "$DSH_COMPOSED_DUMP"
"$GUARD_HOST_LOCK" verify-dump --runtime-root "$DSH_RUNTIME_ROOT" --profile-root "$DSH_PROFILE_ROOT" --dump-config "$DSH_COMPOSED_DUMP"
```

Windows 请通过 profile 的 `node_modules\.bin\dsh-completion-guard-host-lock.cmd` 运行相同的三个子命令，并使用 Windows 绝对路径。DSH、profile 或包升级后需要重新检查。如果当前包集合缺失、混装、重复或不属于已检查环境，Guard 会保持不可用。

然后重启 DSH Web，打开会话并启用 Guard：

```text
/context-guard on
/context-guard status
```

默认采用 opt-in。`status` 显示 Guard 是否开启以及还有多少检查项。`off` 停止保护当前会话，但不删除历史。`clear` 关闭当前待办，同时保留禁止项。`diagnose` 说明完成检查为什么通过或失败。

## 它保护什么

- 保存需求、验收条件、禁止项和后续修正，不覆盖旧记录。
- 只使用 DSH 已保存的工具调用和结果，并保存脱敏摘要而不是完整输出。
- 只有动作和结果对应指定命令、文件或其他目标时，证据才有效。
- 会话重建或恢复后重新检查完成状态；记录损坏时拒绝签发证书。
- 当前检查表尚未通过时，阻止 Guard 自己守卫的 Goal 完成路径。DSH 内部仍可能绕过这条路径，因此插件会报告这些情况，不声称能阻止所有写入。

## 状态与兼容性

0.4.0 是当前版本，可从 [npm](https://www.npmjs.com/package/dsh-completion-guard) 安装。[GitHub Release](https://github.com/GreenLv/dsh-completion-guard/releases/tag/v0.4.0) 附有精确的包校验和，以及 macOS、Windows 原生验收记录。它面向 DSH `0.1.2-alpha.3`、dshmarket `1.39.0` 和 Cordis `4.0.2`。

0.3.2 继续支持已经检查过的 DSH `0.1.1-rc.2` 和 `0.1.2-alpha.2` 环境。不要混用不同环境的包；只有当前包集合完整匹配 [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) 中的一套记录时，Guard 才会启用。

0.4.0 的兼容基线继续冻结在这套 alpha.3 环境。alpha.4 及此后的 alpha 版本不作为新的适配目标；兼容性适配将在上游发布 alpha.3 之后的第一版 RC 时恢复。上游版本进度见 [DeepSeek Harness 标签页](https://github.com/deepseek-ai/deepseek-harness/tags)。

发布包只从干净提交生成一次；同一份包在 macOS 和 Windows 上完成 Web、Headless 原生检查后才会发布。CI、原生生命周期、包发布和公开读回是四类独立证据，详见 [`docs/LOCAL_ACCEPTANCE.md`](docs/LOCAL_ACCEPTANCE.md)。

不建议使用 0.3.0。它的包通过了原生检查，但 npm 没有记录所需的源码提交，因此不能原地修复，也没有 GitHub Release。请使用 0.3.2。

> 本项目于 2026-08-29 由 `dsh-context-guard` 更名为 `dsh-completion-guard`，因为另一个无关插件已经使用旧名称。内部 bundle id 仍为 `context-guard`，旧 npm 包会引导用户使用本包。支持的 DSH 环境见 [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md)；需要 Node.js `>=22` 和 pnpm `>=11`。

## 启用模式

默认 `opt-in` 模式只在会话执行 `/context-guard on` 后开始保护。如需让某个 DSH profile 自动启用 Guard，请在该 profile 的 `cordis.patch.yml` 中增加：

```yaml
- id: context-guard
  name: dsh-completion-guard
  config:
    activation: always
```

重启 profile 后执行 `/context-guard status`。`always` 会在日志重放前启用 Guard，因此重建已有会话时也可能捕获日志中的早期用户消息。如果只希望从显式命令开始保护，请保留 `opt-in`。

## 如何检查完成状态

启用后，Guard 会保存用户直接给出的要求和验收条件。只有已保存的工具结果与指定命令、文件或其他目标一致时，才能作为证据。模型在报告整个任务完成前必须通过 Guard 检查；证据缺失、过期或对象不一致时，任务会保持未完成。

只读证据收集与修改包、文件、服务或 Git 状态的操作使用不同工具。查询成功不会自动产生变更权限。精确命令限制和平台证据见 [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md)。

## 边界

Context Guard 负责完成认证；Goal、Todo、Compaction、continuation、权限和工具执行仍由 DSH 管理。它不是安全沙箱、语义证明系统、token pruning 工具，也不替代这些 DSH 能力。

证据采用有界存储和脱敏处理。Guard 不保存完整 prompt、stdout、文件内容、凭证、Authorization header、URL query value、图片字节或原始 transcript。详见 [`docs/PRIVACY.md`](docs/PRIVACY.md)。

## 与 Codex Context Guard 的关系

本项目最初从 [`GreenLv/codex-context-guard`](https://github.com/GreenLv/codex-context-guard) v0.8.8 移植确定性行为。这个版本只是历史起点，不代表当前兼容程度。

双方当前共享到哪里，由固定的兼容性测试数据和差异台账记录。0.3.2 已包含 Codex 0.9.4 系列的 Stop 2.0、digest v3 和共享兼容性测试。0.4.0 又加入了更严格的任务、路径、能力和证明绑定，具体范围见 [`docs/SEMANTIC_COMPATIBILITY.md`](docs/SEMANTIC_COMPATIBILITY.md)；这里描述的是有明确边界的语义对齐，不代表两个产品完全一致。

两个项目服务于不同运行时：

- `codex-context-guard` 是面向 Codex Hook 的 Python 实现，负责 Codex 插件缓存和 Hook 生命周期接入。
- `dsh-completion-guard` 是独立的 TypeScript 实现，基于 DSH 原生 Session 事件、命令、工具和 Agent 生命周期工作。

两个项目不共享运行时状态、安装器、缓存或发布历史。修复应先进入拥有对应运行时的仓库；只有同一行为确实适用于两侧时，才显式迁移。具体复用与替换边界见 [`docs/UPSTREAM_BASE.md`](docs/UPSTREAM_BASE.md) 和 [`docs/PORTING_NOTES.md`](docs/PORTING_NOTES.md)。

## npm 下载量历史

![dsh-context-guard 与 dsh-completion-guard 的 npm 累计下载增长](https://raw.githubusercontent.com/GreenLv/dsh-completion-guard/stats/npm-downloads.zh-CN.svg)

累计图分别显示更名前后的 npm 包下载总量，标记 2026-08-29 的更名，并仅在项目增长曲线中合并两者。npm 下载量统计的是 registry 请求，不等于独立用户数或已确认的真实安装人数。工作流每天自动更新，也可以手动触发。

## 文档

- [`CHANGELOG.zh-CN.md`](CHANGELOG.zh-CN.md) — 面向使用者的版本变化。
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — 所有权、持久状态和认证管线。
- [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) — 支持的 DSH 版本和可认证命令子集。
- [`docs/LOCAL_ACCEPTANCE.md`](docs/LOCAL_ACCEPTANCE.md) — 确定性、隔离环境、原生平台和公开包验证范围。
- [`docs/distribution.md`](docs/distribution.md) — 已验证的公开分发去向与更名说明。
- [`docs/PRIVACY.md`](docs/PRIVACY.md) — 保存的事实、禁止数据和失败行为。
- [`docs/UPSTREAM_BASE.md`](docs/UPSTREAM_BASE.md) — 历史起点与仓库权威边界。
- [`docs/SEMANTIC_COMPATIBILITY.md`](docs/SEMANTIC_COMPATIBILITY.md) — 当前共享行为和已知差异。
- [`docs/PORTING_NOTES.md`](docs/PORTING_NOTES.md) — 从 Codex 保留的行为和 DSH 专属替换。

## 开发

```sh
pnpm install --frozen-lockfile
pnpm run test:stats
pnpm run typecheck
pnpm test
pnpm run lint
pnpm run build
pnpm run pack:check
```

这些命令验证本地源码树与包。CI、原生平台验收、npm 发布、GitHub Release 身份和真实 profile 安装仍是相互独立的证据范围。
