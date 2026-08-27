# dsh-context-guard

[English](README.md)

面向 DeepSeek Harness（DSH）的任务合同与完成认证插件。它保存需求、禁止项、验收条件、后续修订和有界证据，只有当前成功证据与当前合同匹配时，任务才能获得完成认证。

## 快速开始

将已发布插件安装到 DSH Web profile：

```sh
dsh plugin --profile web add dsh-context-guard@0.2.0
```

重启 DSH Web，打开一个会话并启用 Guard：

```text
/context-guard on
/context-guard status
```

默认采用 opt-in。`status` 会返回启用状态、当前 epoch 和合同修订、待完成与已通过条目数量、证据数量及完整性状态；`off` 停止本会话的捕获和门禁，但保留已有历史；`diagnose` 返回有界的诊断信息。

### 启用模式

`activation` 支持两个值：

| 值 | 行为 |
| --- | --- |
| `opt-in` | 默认值。只有本会话记录了 `/context-guard on` 后才开始保护。 |
| `always` | 在重放会话日志前就进入启用状态。`/context-guard off` 会关闭本会话的 Guard，直到后续再次执行 `/context-guard on`。 |

如需让 Context Guard 在某个 DSH profile 中自动启用，请在该 profile 的 `cordis.patch.yml` 中按插件 ID 增加配置覆盖。macOS 或 Linux 默认 Web profile 的文件通常位于 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- id: context-guard
  name: dsh-context-guard
  config:
    activation: always
```

修改后重启对应的 DSH profile，再在会话中执行 `/context-guard status`，确认 Guard 已启用。由于 `always` 会在日志重放前启用 Guard，把已有 profile 改为该模式后，已有会话在重建日志时也可能捕获更早的用户消息。如果只希望从明确的逐会话命令开始保护，请保留 `opt-in`。

启用后，Context Guard 从用户直接给出的要求和验收条件建立合同。工具结果只有在 DSH 持久化后才会成为可引用证据。模型在声称整个任务完成前，必须调用注入的 `context_guard_checkpoint` 工具并绑定匹配的证据 ID；不完整、过期或对象不匹配的绑定不能签发证书。

## 它保护什么

- 以稳定 ID 捕获 requirement、acceptance 和 prohibition，并通过 append-only supersession 保存后续修订。
- 只从 DSH 已持久化的工具调用与结果派生有界、脱敏的证据。
- 当合同明确指定时，同时匹配方法、操作、对象、surface 和结果状态。
- 在会话重建或恢复时重新验证证书，完整性丢失时 fail-closed。
- 启用期间，如果没有当前有效证书，就阻止 Goal 完成和整任务完成声明。

## 状态与兼容性

0.2.0 已发布到 [npm](https://www.npmjs.com/package/dsh-context-guard) 和 [GitHub Release](https://github.com/GreenLv/dsh-context-guard/releases/tag/v0.2.0)。目标环境为 DSH `0.1.1-rc.2`、Node.js `>=22`、pnpm `>=11`。

0.2.0 版本测试共 124 项，其中 domain/core 104 项。它会在 shell 工具未提供 `workdir` 时使用会话 cwd 归因证据，支持字面量 `2>&1` 和只读检查命令，把过程动词映射为 run 证据，并在 checkpoint 绑定被拒时提供可执行提示。macOS 真实 Web 会话已加载公开 profile 包并认证 `pnpm test` 结果；Windows 0.2.0 原生验收仍待完成。

Context Guard 只识别一小组可审计的 shell 与 PowerShell 命令。无法支持或存在歧义的语法会保持 incomplete，而不会被部分信任。复合命令、变量、非白名单可执行文件、文件目标重定向和 in-place `sed` 仍不在可认证范围内。精确语法和平台证据见 [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md)。

## 边界

Context Guard 负责完成认证；Goal、Todo、Compaction、continuation、权限和工具执行仍由 DSH 管理。它不是安全沙箱、语义证明系统、token pruning 工具，也不替代这些 DSH 能力。

证据采用有界存储和脱敏处理。Guard 不保存完整 prompt、stdout、文件内容、凭证、Authorization header、URL query value、图片字节或原始 transcript。详见 [`docs/PRIVACY.md`](docs/PRIVACY.md)。

## 与 Codex Context Guard 的关系

本项目从 [`GreenLv/codex-context-guard`](https://github.com/GreenLv/codex-context-guard) 迁移确定性行为，以 v0.8.8 作为语义基线，但两者服务于不同运行时：

- `codex-context-guard` 是面向 Codex Hook 的 Python 实现，负责 Codex 插件缓存和 Hook 生命周期接入。
- `dsh-context-guard` 是独立的 TypeScript 实现，基于 DSH 原生 Session 事件、命令、工具和 Agent 生命周期工作。

两个项目不共享运行时状态、安装器、缓存或发布历史。修复应先进入拥有对应运行时的仓库；只有同一行为确实适用于两侧时，才显式迁移。具体复用与替换边界见 [`docs/UPSTREAM_BASE.md`](docs/UPSTREAM_BASE.md) 和 [`docs/PORTING_NOTES.md`](docs/PORTING_NOTES.md)。

## 文档

- [`CHANGELOG.zh-CN.md`](CHANGELOG.zh-CN.md) — 面向使用者的版本变化。
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — 所有权、持久状态和认证管线。
- [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) — 支持的 DSH 版本和可认证命令子集。
- [`docs/LOCAL_ACCEPTANCE.md`](docs/LOCAL_ACCEPTANCE.md) — 确定性、隔离环境、原生平台和公开包验证范围。
- [`docs/PRIVACY.md`](docs/PRIVACY.md) — 保存的事实、禁止数据和失败行为。
- [`docs/UPSTREAM_BASE.md`](docs/UPSTREAM_BASE.md) — 语义基线与仓库权威边界。
- [`docs/PORTING_NOTES.md`](docs/PORTING_NOTES.md) — 从 Codex 保留的行为和 DSH 专属替换。

## 开发

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run lint
pnpm run build
pnpm run pack:check
```

这些命令验证源码和待打包内容。CI、原生平台验收、npm 发布、GitHub Release 身份和真实 profile 安装仍是相互独立的证据范围。
