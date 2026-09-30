# Completion Guard：DSH RC.2 与 Desktop 开发任务

本任务在 `dsh-context-guard` 仓库内独立完成。公开仓库及 npm 产品名是 `dsh-completion-guard`，Cordis entry id 仍为 `context-guard`。目标是把最低支持版本提高到 DSH `0.2.0-rc.2`，支持官方 Desktop，并在本次适配中完成全仓审阅、修复已复现的功能、性能和安全问题。实现完成后交给另一个 Codex 线程独立验收；本文件不是已经通过的实现或发布证明。

## 1. 基线与工作边界

2026-09-30 的调查基线是 `b18d31dda7fdecae5c6496446f33238ea945a93a`、插件 `0.8.1`，调查开始时工作区干净。启动开发时重新读取 HEAD、分支、dirty paths、AGENTS 和工具链，保留非本任务改动。基线变化不自动改变本文件的功能要求。

最低版本是固定策略 `>=0.2.0-rc.2`，最新实际测试宿主暂定 RC.2；构建依赖和测试 runtime 则使用精确 RC.2。三者分别记录。未来升级不自动追随 registry `latest` 提高下限；高于下限的宿主不能因为未列入测试清单而被拒绝。实际 API、完整性或行为不合格仍必须拒绝相应能力。

本轮准备已把本机 Web runtime 升至 RC.2，官方 Desktop 也为 RC.2。现有 Guard 保留安装但暂时禁用；旧 RC.1 host lock 保留用于恢复，不能直接用于 RC.2。当前状态及私有回读在 codex-sync 的 RC.2 准备记录中，不能当成新插件验收。

本仓库自行设计、实现、检查和交付，不依赖 Session Insights 的进度或发布。开发 harness 不修改另一个插件、codex-sync 的消费者 pins、日常 runtime 或 Desktop app bundle。需要消费者适配时返回明确的适配要求。不要发布 npm、创建 tag/Release、推送、迁移日常 profile 或启用日常插件；这些是后续独立操作。分支采用 `codex/` 前缀，按平台权限执行。

## 2. 已核实的上游与源码事实

- [官方 RC.2 发布页](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2)，tag `dsh-v0.2.0-rc.2`，发布关联提交 `639ed01`。相关变化包括 Desktop 官方 dsh 命令、图形启动的登录 shell 环境、PowerShell 完成状态识别、定时消息语义及实验性异步问答。
- RC.2 官方 `dsh-app-boot` 的 `evaluatePluginCompatibility()` 使用 `includePrerelease: true` 检查 DSH peers。必须用这个真实消费者及市场消费者验证范围，不能只测普通 node-semver。
- 现有 `src/domain/host-version.ts` 已把最低版本与 `HOST_VALIDATED_VERSIONS` 分离；`host-lock.ts`、`host-trust.ts`、`host-resolver.ts` 和 `host-contract-program.ts` 已有 graph-derived registry rebind 路径。保留它，不能退回“每个新版本加一行才支持”的实现。
- `HostProfileKind` 只有 `web | headless`；profile 识别、目标图、lock 注入和 native 工具均没有正式 Desktop 分支。`resolveActiveProfileHostLock()` 用 Web bundle/market 推断 profile，Desktop 也包含 Web app bundle，不能沿用该推断。
- 现有源码测试基线（RC.1 测试依赖）：`pnpm test` 为 169 个文件通过、1 个文件跳过；2812 个测试通过、7 个跳过。只建立现有源码基线，不建立 RC.2、Desktop、新 tgz 或新模型行为证据。

## 3. 本次问题登记

| ID | 级别与状态 | 定位与影响 | 结案要求 |
| --- | --- | --- | --- |
| CG-RC2-001 | 必须实现；已确认 | package.json 的双层 engines/DSH peers，`host-version.ts`、RC.1 manifest/dev pins：下限仍为 RC.1 | 所有当前准入面统一 RC.2 下限；RC.1 拒绝，后续 RC/stable 接受版本准入；历史记录保持原事实 |
| CG-RC2-002 | 必须实现；已确认 | `host-lock.ts`、`host-resolver.ts`、`config.ts`、bin、native scripts：Desktop 缺失且可被误识别为 Web | 显式 Desktop 身份、正确官方 CLI/Node/包图、独立 profile-bound lock 和生命周期证据 |
| CG-RC2-003 | P2；强制测量后结案 | `runtime.ts` 的 `rebuild()`、`sync()`，`session-events.ts` 与 private-ledger：反复全日志投影；host audit 是同步 I/O | 测事件数/entry 次数/文件读取/耗时和峰值资源；可复现回退必须修复。不得凭猜测新增跨 entry 信任缓存 |
| CG-RC2-004 | 语义适配；强制设计与复现 | RC.2 schedule 产生 `source.kind=schedule` 的 user message；`derive.ts` 对 root input 只接受 `kind=user` | 明确定时指令/用户授权继承策略，覆盖真实生产路径；不能简单把所有 schedule 或 role=user 都升级成 root authority |
| CG-RC2-005 | 审阅风险；待复现 | RC.2 异步问答、late answer、取消、resume、子代理通知与 Stop/Goal/boundary 状态交互 | 无提前结案、重复 capture、错误暂停或旧证书复用；实验功能关闭/开启分别检查适用行为 |

CG-RC2-004 的合成对照已在提交的 dist/domain 运行：相同 user-role 文本，`source.kind=user` 得到 `realRootInputSeen=true`，`kind=schedule` 得到 false。它证明现行来源分类差异，尚不证明新的授权策略应当如何实现。必须核对实际定时任务记录、用户授权与宿主投递关系，再决定适配或保留限制并给出理由。

对于新增发现：先建立最小复现和稳定 ID，记录影响、共同原因、修复与回归。不能把猜测写成已确认漏洞，也不能以“这只是审阅”略过已复现的本次范围内问题。低价值重构和新产品功能可列 backlog，必须说明边界。

## 4. 设计与实现要求

### 版本准入与宿主资格

1. 同步顶层 `engines.dsh`、`dsh.engines.dsh`、各 DSH peer 最低值、运行时 floor、支持 manifest、生成工具、当前 README/兼容性/迁移文档及 fixture identity。dev pins 和实际测试 runtime 精确绑定 RC.2；Cordis 单独验证，不因 DSH 版本一起随意放宽。
2. 版本向量至少含：RC.1、RC.2、RC.3、0.2.0 stable、0.2.1-rc.1、0.3.0-rc.1、1.0.0、带 build metadata 的 RC.2、非法值。未来版本仅做消费者/生产准入合成测试，不谎称真实宿主验收。
3. RC.2 关键包从官方 archive/SRI 重新研究，报告实际 API/程序/依赖与 RC.1 差异。保留旧 manifest 的历史用途；新的资格证明必须绑定所有实际选中 executable/JSON inventory、ESM/CJS 路由、Node conditions 和依赖身份。
4. 验证“新但兼容的程序经生产 rebind 可以资格化”和“API/行为/字节/路由破坏被拒绝”。不能用测试 seam、复制已签信任、仅换版本字串或只扩 cohort 表来替代。
5. 核对 Goal、jobs、shell、fs、session flush 的必要/可选能力边界；缺可选 Goal 时只按既定策略禁用 Goal，不把整套 core 误报支持或全部瘫痪。

### Desktop

1. 使用官方 app 的命令 carrier 与 bundled Node/pnpm。Web/Headless 仍使用显式管理的 CLI runtime。PATH 上同名 dsh、系统 Node、临时 npm CLI 均不是 Desktop 身份替代物。
2. 读取 app/runtime/host/primary metadata、profile bundles、实际 import graph 和真实解析路由。app.asar/安装型图没有 pnpm `.package-map.json` 时设计真实适配器；不能伪造 map，也不能把 app bundle 解包后当作官方运行图。
3. Desktop profile 身份独立进入 digest、trust receipt、lock、config schema 和 native annex。Web lock 或证书不得复制到 Desktop；app 或 profile 路径别名、同名包 shadow、混合图、错误 Node startup conditions 均需负例。
4. 扩展 repository-owned host-lock/native 工具：显式选择 Desktop，不要求 CLI 启动桌面 UI；通过官方图形启动/退出处理生命周期，安装前检查主程序及 host children 已退出，尤其 Windows 原生模块占用。
5. 升级与重装保留模型/MCP、bundles、禁用偏好、skins、日常数据和 account state；备份、atomic apply、失败恢复及第二次严格 no-op。不要改 app.asar 或绕过 Desktop 保留 profile 管理。

### 全仓审阅与性能

至少逐项覆盖：root capture/附件及引用授权、work units/supersession、evidence/target/locator/digest、checkpoint/closure/Stop、Goal、recovery/compaction/replay、private ledger/损坏恢复、external operations/jobs/用户暂停、release reservation/settlement、shell/pwsh/fs/native adapters、host version/graph/trust/rebind、CLI/安装/迁移、公开隐私、双语文档、pack inventory/CI。包含提交的 dist、manifests、tests、scripts、bin 和 npm 文件表；文档里的宣称也要对照实际执行入口。

提交覆盖表：模块/阅读位置/生产入口/现有测试/新增复现/结案或残余风险。审阅不是给所有目录标一个“看过”。特别检查 RC.2 PowerShell 末尾空格/退出码、unknown tool outcome 不能成为成功或确定失败、late user answer 不能串 turn、历史工具文本不能创建 authority。

性能至少对 0、100、1000、10000 个事件和短/长私有账本测量，包含长 tool output；同一宿主同一环境各 5 次，报告中位数与 p95、物理读取次数/字节、投影次数和峰值 RSS。性能 harness 的 synthetic/source/native 分类必须明确。修复重复解析/无界输入/泄漏时保留新鲜的 pre-effect host validation、durability 与 fail-closed；无可复现回退可用有依据的“无需变更”结案。

## 5. 开发、打包与验收

先关闭复现问题，再做完整 candidate gate。按 AGENTS 的完整矩阵：typecheck、lint、Vitest、release-pack tests、stats tests、build、pack dry run、文档 audit 及其测试、`git diff --check`；build 后核对 dist 无意外漂移。选择器和 repair-families 可用于修复阶段，不代替 freeze 矩阵。

最终按仓库干净源码要求提交一个本任务候选 commit（若接收线程的实际权限允许）；不要混入 unrelated changes。使用 `scripts/release-pack.mjs` 生成唯一 tgz、SHA256SUMS 和 release-artifact。新版本原暂建议 0.9.0；独立复核确认未改变任务、证书或数据协议，按维护者的版本连续性要求采用 0.8.2；不占用已发布版本。不在不同平台重打包，不提前发布。

| Gate | 独立验收要检查的事实 |
| --- | --- |
| G1 源码与准入 | RC.2 floor、真实 DSH/market 消费者、未来版本合成向量、Core/Goal 资格与拒绝路径；全仓问题登记结案 |
| G2 portable/CI | repository-owned 实际生产入口、RC.2 契约、跨 OS/Node 矩阵；不将 fixture pass 报成原生通过 |
| G3 制品 | 全 commit、tgz SHA256、嵌入 gitHead、安装文件 inventory、clean source、dist 同步 |
| G4 macOS native | 同一 tgz 的 Web、Headless、官方 Desktop 安装、strict no-op、lock/字节/路由、启动/取消/重启/恢复、卸载/清理与状态还原 |
| G5 Windows native | 独立执行同样三种宿主；Desktop 真 app、pwsh/shim/原生模块占用，不用 macOS 或 CI 代替 |
| G6 行为与页面 | 非空真实生产路径的 capture→checkpoint→Stop，未满足拒绝、满足允许、暂停/等待/Goal/compaction；Desktop 实际设置和插件状态；必要的模型批次单独绑定来源和结果 |
| G7 文档 | 中英文 README/CHANGELOG/兼容性/升级操作清晰且事实一致；最终字节 cold review，公开面无私有路径/真实会话 |

初始开发验收至少完成 G1–G3 和可用平台的 G4/G5；缺少平台或模型能力必须保留 pending，不能整体标“支持 Desktop 已验收”。独立 Codex 验收最终关闭所需平台/模型/UI gates，输出逐项结果，不把发布或消费者 apply 混入开发结论。真实模型沿用现有登录，不因隔离 HOME 重做登录；未运行的部分明确给出 owner 和 resume event。

## 6. 返回给独立验收线程

交付一个聚合 handback：候选 commit/dirty 状态与任务 diff；稳定问题 ID、复现及修复解释；全仓审阅覆盖与性能数据；源码/CI/制品/native/模型/UI 各自的命令、结果和 subject identity；唯一 tgz 与 checksum/inventory；final reader-review；公开可用的迁移说明；仍待验收项、未执行外部操作和恢复方法。使用 `agent-handoff/v1`，不要返回真实会话或原始凭据日志。

独立 Codex 线程先阅读这个 handback、检查 subject 和差异，再对缺失或失效的 gate 验收。修复回合只重跑受影响 gates，重复同类失败时审查共同原因及所有入口，不重复无关通过项。
