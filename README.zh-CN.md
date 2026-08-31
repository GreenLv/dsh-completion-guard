# dsh-completion-guard

[English](README.md)

面向 DeepSeek Harness（DSH）的任务合同与完成认证插件。它保存需求、禁止项、验收条件、后续修订和有界证据，只有当前成功证据与当前合同匹配时，任务才能获得完成认证。

![任务合同条款与有界证据通过 checkpoint 匹配后签发完成证书](assets/social/completion-guard-hero.png)

## 快速开始

将已发布插件安装到 DSH Web profile：

```sh
dsh plugin --profile web add dsh-completion-guard@0.3.1
```

重启 DSH Web，打开一个会话并启用 Guard：

```text
/context-guard on
/context-guard status
```

默认采用 opt-in。`status` 会返回启用状态、当前 epoch 和合同修订、待完成与已通过条目数量、证据数量及完整性状态；`off` 停止本会话的捕获和门禁，但保留已有历史；`clear` 在 `CLEAR:` 哨兵下使所有待完成的 requirement/acceptance 成为 superseded（保留 prohibition），从而让空绑定 checkpoint 也能在 Guard 保持开启的情况下签发证书；`diagnose` 返回有界的诊断信息。

### 启用模式

`activation` 支持两个值：

| 值 | 行为 |
| --- | --- |
| `opt-in` | 默认值。只有本会话记录了 `/context-guard on` 后才开始保护。 |
| `always` | 在重放会话日志前就进入启用状态。`/context-guard off` 会关闭本会话的 Guard，直到后续再次执行 `/context-guard on`。 |

如需让 Context Guard 在某个 DSH profile 中自动启用，请在该 profile 的 `cordis.patch.yml` 中按插件 ID 增加配置覆盖。macOS 或 Linux 默认 Web profile 的文件通常位于 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- id: context-guard
  name: dsh-completion-guard
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
- 启用期间，如果没有当前有效证书，就在 mutation 前阻止 Guard 自己守卫的模型工具 Goal 完成路径；可信进程内直接写 Goal/session 的旁路只检测为 integrity violation，不声称能普遍阻止。

## 状态与兼容性

0.3.1 是当前 release line。只有 [`docs/LOCAL_ACCEPTANCE.md`](docs/LOCAL_ACCEPTANCE.md) 记录的精确工件公开读回闭合时，其 [npm 包](https://www.npmjs.com/package/dsh-completion-guard) 与 [GitHub Release](https://github.com/GreenLv/dsh-completion-guard/releases/tag/v0.3.1) 才构成权威发布身份；安装前请核对这些链接身份。

`0.3.0` npm 工件已通过原生平台同字节验收，但由于发布的是预构建 tgz，npm 没有写入合同要求的 `gitHead`。该版本身份不能复用，也不会为 `v0.3.0` 创建 GitHub Release；`0.3.1` 保留其运行时行为并修复发布溯源路径。

> 本项目于 2026-08-29 由 `dsh-context-guard` 更名为 `dsh-completion-guard`，以避免与无关的 DSH 插件（kpl0111/dsh-context-guard，工具结果剪裁）撞名。内部 Cordis bundle id 保持 `context-guard` 不变；原 npm 包 `dsh-context-guard` 的所有已发布版本均已 deprecate 并指向本包。目标环境为 DSH `0.1.1-rc.2`、Node.js `>=22`、pnpm `>=11`。

### 早期 v0.2.x 证据

0.2.1 版本测试共 138 项，其中 domain/core 105 项。它会在 shell 工具未提供 `workdir` 时使用会话 cwd 归因证据，支持字面量 `2>&1` 和只读检查命令，把过程动词映射为 run 证据，并在 checkpoint 绑定被拒时提供可执行提示。0.2.1 新增会话层捕获过滤，使澄清提问、元评论和纯推进语（`继续`、`continue`）不再成为合同条目；对重复恢复通知做内容去重；新增 `/context-guard clear`；并文档化在 Guard 关闭或阻塞时 goal 如何完成。macOS 真实 Web 会话已加载公开 profile 包并认证 `pnpm test` 结果。

Windows TEMP 读回现已确认 `b75868e9e73d29f50530ddaba15cfaef82e03ece` 的源码矩阵，以及 exact-source tarball → 隔离安装 → dump-config → Web 启动日志与清理链。HTTP 200 只出现在首轮 stdout，未持久化且复核时没有重跑，因此 HTTP 响应本身不能写成“独立复核已确认”。真实模型会话 smoke 仍未运行。

### v0.3.1

v0.3.1 承载 0.3.0 引入的语义 action/target 绑定、有状态动作独立读回、typed boundary、digest-v3 证书、精确活动宿主身份和成对 optional Goal 集成，并增加确定性 release packer，在原生平台验收与 registry 发布前把完整 Git HEAD 绑定进冻结 tgz。对于未变化的运行时基线，19 个测试文件在 macOS 通过 351 项并按能力跳过 1 项 Windows-only 测试，在原生 Windows 通过全部 352 项且无跳过。[`docs/LOCAL_ACCEPTANCE.md`](docs/LOCAL_ACCEPTANCE.md) 分别记录源码、工件、CI、模型会话与 publication 证据边界。

该版本使用 [`manifests/action-manifest.v1.json`](manifests/action-manifest.v1.json)、[`manifests/git-command-manifest.v2.json`](manifests/git-command-manifest.v2.json) 与 [`manifests/supported-host.v1.json`](manifests/supported-host.v1.json)。Goal 集成要求精确 optional peers `@deepseek-ai/dsh-goal@0.1.1-rc.2` 和 `@deepseek-ai/dsh-tool-goal@0.1.1-rc.2` 同时存在。活动 DSH runtime/profile graph 未显式注入精确 `hostLockPackages`、platform 与 profile 身份时一律 fail-closed。由于 DSH 核心与 profile 插件使用不同 package graph，运行时不接受“向上找到的最近 lockfile”替代活动宿主身份；默认 bundle patch 也不会伪造这份锁。

把该版本安装到 profile 后，使用随包提供的 CLI 生成并回读活动身份。请把下列路径替换为实际 DSH 安装的绝对路径；dump 只是检查产物，不是配置来源：

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

`inspect` 与 `inject` 会拒绝缺失、重复、多版本或漂移的关键包；`verify-dump` 再证明 DSH compose 出的有界 tuple 与活动 graph 读回一致。每次 DSH/profile/package 升级后都应重跑。流程未通过前，证书、依赖 Goal 的完成路径及受影响 action capability 均保持 unavailable。发布验收使用全新隔离 profile，未覆盖用户现有 DSH profile。

`context_guard_evidence` 只读：负责 target resolution、已持久 effect 验证和独立 state readback。install/apply/restart/publish 以及精确 Git commit/push/pull/fetch mutation 使用单独命名的 `context_guard_action`。resolution 本身不授予 mutation 权限：调用方必须给出精确的 pending 根用户 requirement 及修订、复述已持久 target digest，并逐字段匹配动作所需身份；prohibition 与 acceptance 条目绝不授权 mutation。v0.3 的 package/apply/publish 只接受精确版本授权，Git 授权必须给出 remote 与 canonical 完整 ref/refspec。这些检查在任何 executable、HTTP 请求或 restart intent 之前完成。审批/展示面会在执行前呈现 canonical target 和 command-manifest digest。

Publish target 只接受不含凭证、query、fragment、歧义路径或控制字符的 canonical HTTPS registry base；根合同、npm argv 与 registry readback 冻结同一值。Create/modify resolution 会在 effect 前冻结预期写入后的 digest；modify 还会先把源字节重新散列并与冻结的 pre-digest 比较，再按 pinned、唯一 UTF-8 replacement 语义推导 post-digest，因此 prestate 漂移或不同的实际文件字节都会 fail closed。

Context Guard 只识别一小组可审计的 shell 与 PowerShell 命令。无法支持或存在歧义的语法会保持 incomplete，而不会被部分信任。复合命令、变量、非白名单可执行文件、文件目标重定向和 in-place `sed` 仍不在可认证范围内。精确语法和平台证据见 [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md)。

## 边界

Context Guard 负责完成认证；Goal、Todo、Compaction、continuation、权限和工具执行仍由 DSH 管理。它不是安全沙箱、语义证明系统、token pruning 工具，也不替代这些 DSH 能力。

证据采用有界存储和脱敏处理。Guard 不保存完整 prompt、stdout、文件内容、凭证、Authorization header、URL query value、图片字节或原始 transcript。详见 [`docs/PRIVACY.md`](docs/PRIVACY.md)。

## 与 Codex Context Guard 的关系

本项目从 [`GreenLv/codex-context-guard`](https://github.com/GreenLv/codex-context-guard) 迁移确定性行为，以 v0.8.8 作为语义基线，但两者服务于不同运行时：

- `codex-context-guard` 是面向 Codex Hook 的 Python 实现，负责 Codex 插件缓存和 Hook 生命周期接入。
- `dsh-completion-guard` 是独立的 TypeScript 实现，基于 DSH 原生 Session 事件、命令、工具和 Agent 生命周期工作。

两个项目不共享运行时状态、安装器、缓存或发布历史。修复应先进入拥有对应运行时的仓库；只有同一行为确实适用于两侧时，才显式迁移。具体复用与替换边界见 [`docs/UPSTREAM_BASE.md`](docs/UPSTREAM_BASE.md) 和 [`docs/PORTING_NOTES.md`](docs/PORTING_NOTES.md)。

## npm 下载量历史

![dsh-context-guard 与 dsh-completion-guard 的合计累计 npm 下载量增长](https://raw.githubusercontent.com/GreenLv/dsh-completion-guard/stats/npm-downloads.zh-CN.svg)

该累计图分别展示新旧 npm 包的总量，以竖线标记 2026-08-29 更名，并且只在项目增长曲线中合并两者。npm 下载量统计的是 registry 请求次数，不等于独立用户数或已确认的真实安装人数。工作流每天运行，也支持手动触发。

## 文档

- [`CHANGELOG.zh-CN.md`](CHANGELOG.zh-CN.md) — 面向使用者的版本变化。
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — 所有权、持久状态和认证管线。
- [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) — 支持的 DSH 版本和可认证命令子集。
- [`docs/LOCAL_ACCEPTANCE.md`](docs/LOCAL_ACCEPTANCE.md) — 确定性、隔离环境、原生平台和公开包验证范围。
- [`docs/distribution.md`](docs/distribution.md) — 已验证的公开分发去向与更名说明。
- [`docs/PRIVACY.md`](docs/PRIVACY.md) — 保存的事实、禁止数据和失败行为。
- [`docs/UPSTREAM_BASE.md`](docs/UPSTREAM_BASE.md) — 语义基线与仓库权威边界。
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
