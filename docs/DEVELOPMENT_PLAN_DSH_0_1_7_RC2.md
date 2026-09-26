# DSH Completion Guard：精准适配 DSH 0.1.7-rc.2 开发计划

计划版本：1.0。调研日期：2026-09-26。状态：可供后续会话执行的开发计划，尚未实施、测试候选或完成原生验收；不是已通过独立审查的冻结规格。

目标：将当前 `dsh-completion-guard@0.7.1` 迁移到 **仅支持 DSH `0.1.7-rc.2`**，保留普通工作、恢复反馈、proof、Goal 和受控 release 的职责边界。建议插件下一版使用 `0.8.0`，因为宿主支持范围收窄且涉及生命周期与持久化接入变化；实施入口核对版本是否已被占用，再确定最终版本。

本计划的编写授权不包含执行升级、安装日常 Profile、修改其他仓库、提交、推送或发布。后续会话的执行权限由用户当时的指令确定。计划中的发布流程是将来的交付条件。

## 1. 结论与适配范围

这次不是修改版本字符串即可完成的升级。rc.1 引入的 Agent 初始化、Session V4、Jobs 调用者身份和 shell 后台化变化都被 rc.2 继承；rc.2 又增加动态工具历史和请求构造变化。必须同时处理这两层。

最终只保留一条生产适配路径：DSH `0.1.7-rc.2`。不构建 rc.1 兼容分支，不保留旧宿主作为自动 fallback，也不使用 `>=0.1.7`、`^0.1.7` 或多个 RC 的并集。历史测试数据可以保留，但不能让历史 cohort 成为可运行的支持入口。

范围包括：依赖与包元数据、宿主图和已审计实现字节、生命周期、Session V4 证据、Jobs/终端结果、工具注册及卸载、现有文件观察和 Goal/Stop 接线、测试夹具、原生验收入口、文档与生成的 `dist/`。

不扩展到：实现定时任务插件、远程 SSH 文件认证、完整 Desktop 专项支持、浏览器/Computer Use 证据适配、新模型供应商、重写共享语义核或全面异步化历史投影。新宿主具备某项能力不等于 Guard 已能认证该能力。未覆盖的来源保持 unknown/unavailable，普通宿主工作仍按既有职责运行。

## 2. 已核实基线与证据

下表是调研时快照；实施入口重新核对可变状态，但目标版本保持 rc.2，不随 `latest` 漂移。

| 对象 | 核实结果 |
| --- | --- |
| 本仓库 | `c6e14cd8aaf755e8cfb41a343c67e6e64659969c`，开始调研时工作区干净，包版本 `0.7.1` |
| 当前支持声明 | `0.1.5-rc.2 || 0.1.5-rc.1`；开发依赖主体仍是 `0.1.5-rc.1`，Cordis 为 `4.0.2` |
| 对比起点 | `dsh-v0.1.5-rc.2` → `fb2c4b9e698e30edb738bca4cf0618587db7d203` |
| 中间版本 | `dsh-v0.1.7-rc.1` → `46a7f68b0922371ce7144b668b90e377d8e799f4`，2026-09-23 发布 |
| 唯一目标 | `dsh-v0.1.7-rc.2` → `477b4f420553e8a52c2fbccc464d7561b239c443`，2026-09-24 发布 |
| 目标 Cordis | 上游源码为 `4.0.4`；npm 中 DSH rc.2 依赖 `~4.0.4` |
| Registry 初查 | 当前 cohort/开发依赖涉及的 36 个包名均查到目标版本元数据；这不是完整运行图，也没有证明 tarball 或安装字节 |

本次比较了三个 tag 的源码归档，而非只读 release notes。GitHub compare API 的文件列表只返回了 300 项，不能把该列表当作完整差异。rc.1 的说明自称汇总自 0.1.5-rc.3 以来的变化，所以只阅读 rc.1/rc.2 两份发布说明还会漏掉当前插件基线之前的一段差异；从 0.1.5-rc.2 起比较源码覆盖了这段缺口。

可复核材料：

- [rc.1 官方发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.1)
- [rc.2 官方发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.2)
- [rc.1 到 rc.2 官方比较](https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.1.7-rc.1...dsh-v0.1.7-rc.2)
- [调研证据清单](dsh-0.1.7-rc.2-planning-evidence.json)：完整 commit、所读上游文件的 SHA-256/固定链接，以及 36 项 Registry SRI。

证据清单只能用于重现调研，不得直接作为新的 `supported-host` 清单或原生通过记录。后续必须读取目标安装图，并核验实际包字节。

## 3. rc.1 与 rc.2 分别影响什么

| 编号 | 来源与源码事实 | 当前插件影响 | 处理决定 |
| --- | --- | --- | --- |
| U01 | rc.1 将 `agent/session-start` 改为串行等待的 `agent/created`；`AgentRegistry.register()` 返回需等待的 effect disposer | `src/runtime.ts` 仍监听旧事件；多处测试/探针模拟旧回调 | 必改。迁移注册事件和等待顺序，首次请求之前完成 Guard 初始化；禁止两个事件同时监听 |
| U02 | rc.1 将 `SESSION_FORMAT_VERSION` 从 3 改为 4，并调整 fork seed 闭合语义 | `host-workdir.ts` 显式要求 `header.version === 3`，并以 3 计算会话摘要 | 必改。V4 会话身份、fork/resume、真实日志恢复共同验证；禁止伪装成 V3 |
| U03 | rc.1 弃用 `snapshotEvents/eventAt/ownEvents`；rc.2 实现仍保留完整内存日志及这些方法，上游允许既有调用暂缓迁移 | Guard 的同步投影、命令、观察器和部分证据读取依赖 `snapshotSessionEvents` | 保留既有单一入口作为本轮受控技术债，校正 V4 描述和校验；不新增任意同步历史扫描，不把弃用当成方法已删除 |
| U04 | rc.1 的 Jobs `get(id, caller)` 从 `Agent`/`JobSnapshot` 改为 `SessionId`/`JobView` | `readExternalOperation()` 仍传整个 Agent，并用结构强转隐藏接口差异 | 必改。按真实类型传会话身份；错误和越权不得兜底成 running |
| U05 | rc.1 的 bash/pwsh 在有 Jobs 服务时可把超时前台任务保留为后台任务；rc.2 保留该行为 | 旧规则主要依据 `run_in_background` 与尾部失败标记，默认前台无标记可能判为成功；新 promotion 文本尾部还有说明句 | 必改。识别未终结结果，不能仅替换 renderer hash 后继续沿用旧成功推断 |
| U06 | rc.1 引入本地宿主访问远程工作区、异步可取消 shell/sandbox 接口与路径解析调整 | 现有 cwd 收据、文件观察和本地字节读取依赖已审计本地路由 | 重审本地执行路径；远端/未知 provider 不产出本地认证证据，不把远端路径交给本地 fs 回读 |
| U07 | rc.1 改变插件加载/卸载与配置热更新：激活失败可能部分生效；安装启动会检查 DSH peers | 仅改 `engines.dsh` 不够；agent 作用域注册可能随插件卸载残留 | 所有支持声明一致；隔离测试重载、失败与清理；禁止通过 `allow-version` 绕过验收 |
| U08 | rc.2 增加 `developer/message`、`toolHistory()`，工具增删通过 `headerSeq` 关联请求历史 | `derive`、root 来源判定、工具重载和恢复轨迹出现新事件 | 新事件可以参与宿主投影，但不能成为用户授权、业务成功或完成证据；覆盖增删后首次请求、resume 和 compact |
| U09 | rc.2 修正 request series 起点，恢复首个 pre-step 压缩仍须标记新序列 | Guard 的恢复去重、触发原因和首轮注入可能被请求级变化扰动 | 以真实业务/持久化水位决定恢复；请求 header 变化本身不制造新待办 |
| U10 | rc.2 的 `PreToolDecision.ask` 加入可本地化 `displayReason`；自动审阅拒绝与失败处理调整 | Guard 必须继续使用真实工具结果与单调拒绝，不可解析 UI 提示当审批事实 | 保持 `tools.guard` 的禁止语义；覆盖 allow/deny/cancel/ask、人工处理后的实际执行结果 |
| U11 | rc.2 的 Goal 工具主要调整描述；Goal 初始化在 rc.1 已改到 `agent/created`，`complete`/`disarm` 仍存在 | 不需要重做 Goal 服务，但要验证 Guard 初始化及宿主工具 guard 顺序 | 保留 complete 前校验、持久化失败拒绝、resume 后 disarm 行为；不用工具描述文字匹配判断身份 |
| U12 | rc.1 PTC 服务统一为 `ptc-runtime`，workflow 也更名；rc.2 保留调度/日志机制 | `run_code` 子调用证据和原生 composition 可能用到旧插件名/服务名 | 检查原生 fixture 与 PTC 日志真实入口；不为旧命名保留生产 shim |

此外，rc.2 新增定时任务与动态启用工具、默认关闭部分时间/定时能力、Inspector 不再默认提供。Guard 不应硬依赖这些默认组件；定时触发、工具注册通知和自动审阅消息均不能冒充根用户输入。界面外观、Office 预览等变化不进入此次实现范围。

### 3.1 关键源码定位

上游路径均相对于证据清单中的 rc.2 commit：

- `packages/core/agent/src/runtime-types.ts`、`index.ts`：`agent/created`、serial 初始化、register/announce/dispose。
- `packages/core/session/src/{types,index,fork,tool-history}.ts`：V4、仍存在的 deprecated API、fork 合成关闭、动态工具历史。
- `packages/core/agent-loop/src/agent.ts`：`developer/message`、`headerSeq`、`startsSeries`。
- `packages/jobs/jobs/src/{index,view}.ts`、`jobs-local/src/index.ts`：SessionId 调用者及 owner fence。
- `packages/shell/tool-{bash,pwsh}/src/{index,render}.ts`：超时后台化和结果文本；bash 的 `renderPromoted()` 产生 still-running 标记并追加说明。
- `packages/boot/app-boot/src/plugin-compatibility.ts`：安装前基于 DSH peers 检查，不依赖载入插件代码。
- `packages/goal/{goal,tool-goal}/src/index.ts`、`packages/core/tools/src/index.ts`：Goal 生命周期与单调 tool guard。

## 4. 实施时必须维持的约束

1. **唯一宿主身份**：元数据、devDependencies、运行时支持集、CLI、fixture、文档均指向 rc.2。Cordis 单独定版；建议本插件 peer/dev 与首个 cohort 都固定 `4.0.4`，后续独立版本不自动视为支持。
2. **身份与能力分开**：目标版本字符串、Registry SRI、安装路径/模块字节、当前加载图、原生行为分别取证。版本匹配不能替代 host-lock。
3. **Session 格式与摘要版本分开**：DSH V4 不是 Guard protocol v4，也不是 digest v4。现有 digest 算法/共享字段原则上不变，真实 `version: 4` 作为已有字段输入；不可把它强制改回 3 以保住旧证书。
4. **来源不升级**：system/developer/plugin/scheduler/subagent 信息不因新格式而成为 root instruction；fork 的合成 `turn/end: forked` 不是正常完成。
5. **未结束不是成功**：后台化、取消、审批拒绝、未知输出、水位未持久化，均不能生成成功认证。后台任务 completed 也不自动证明测试通过或业务状态已满足。
6. **既有职责不回退**：普通工作通过宿主工具完成；unknown 证据不得让用户重做业务。恢复、prepare、checkpoint 使用同一当前投影，保留 0.7.1 的恢复反馈修复。
7. **不扩权清旧状态**：移除旧宿主运行支持不意味着删除历史记录、改写历史证书、自动迁移 release reservation 或默默解除禁止事项。

### 4.1 历史会话与旧宿主的区别

不再支持旧宿主，但 rc.2 可以打开上游已迁移的旧会话。因此需验证“rc.2 读取迁移后的 V4”以及历史证据降级，不需保留 Guard 自有 V3 运行分支或启动旧宿主进行长期兼容测试。

默认迁移政策：旧记录保留为历史；host-lock、会话身份或私有 ledger context 不匹配时，不提升为当前认证，也不自动重签。release reservation/settlement 或 restart intent 绑定旧 context 时，明确显示历史状态及当前不可认证原因。普通任务可以继续；严格契约必须重新建立当前有效的证明基础。不要自动删除或重新 anchor 旧 ledger。

若实际迁移改变了事件序号/来源引用，新增专门迁移诊断并保留原始引用；不得用序号猜测映射。该问题的修复限于安全读取与明确诊断，不扩展成旧宿主支持。

## 5. 工作包与执行顺序

依赖顺序：P0 → P1 → P2/P3/P4 → P5/P6 → P7 → P8。这是同一写入者的工作拆分，不要求并行代理；需要并行时先明确各自独立的路径或 worktree。

### P0：建立 rc.2 可重现输入

产出：升级分支、实际包图/来源清单、上游 API 对照表更新草案。

- 核对 HEAD/dirty、当前用户权限和既有未完工作；需要隔离时使用 `codex/` 前缀的新分支/worktree。
- 固定本计划给出的 rc.2 commit、npm 精确版本；查询时禁止依赖 dist-tag。
- 下载实际需要的 rc.2 tgz，验证 SRI，记录 tarball digest、包 manifest、运行时模块文件 hash。
- 从真实 rc.2 Web/Headless 安装解析 active graph 与 `.package-map.json`。不要假设旧的 33 行图依然完整；为保留、删除、新增的关键包逐项记录原因。
- 审核 CLI、session/persistence、projection、goal/round-driver、jobs、shell/local/sandbox、plugin manager/boot 这些实际承担可信链的模块。是否扩入 host-lock 由它是否参与被认证行为决定，不把整个上游依赖树无差别固化。
- Registry 清单可由单一数据源生成 TypeScript/JSON，或增加二者严格一致性检查；不要维护两份可漂移的手写清单。

退出条件：不存在未知版本、占位 hash 或用旧 SRI 替换版本号的行；缺少原生审计时保持 `auditedPlatforms: []` 与准确 provenance。

### P1：收窄依赖、cohort 与实现字节

主要文件：`package.json`、`pnpm-lock.yaml`、`src/domain/host-version.ts`、`host-lock.ts`、`host-resolver.ts`、`manifests/supported-host.v1.json`、host-lock CLI。

- `dsh.engines.dsh`、`engines.dsh`、全部 DSH peers 与实际开发依赖统一精确 `0.1.7-rc.2`；Cordis 按 P0 的单独版本处理。保留 Goal optional 的产品语义，并验证缺少 Goal 时普通路径可用。
- 新增目标专用包行模块（建议 `src/domain/rc017-rc2-host.ts`），活动 cohort 只有 rc.2。消除最低版本诊断被当成广义支持判定的可能。
- 历史 cohort 若仍用于解码/负例，移入明确的历史数据路径；不再进入生产 resolver 的可接受集合或新安装选择器。不能仅保留一个 `supported=false` 标签却仍参与能力授权。
- 重新审计 `AUDITED_FOREGROUND_BYTES` 和 `AUDITED_DEFAULT_WORKDIR_BYTES`。更新 `activeRendererModule()` 中旧版本正则、manifest 约束以及实际 entry 路径；从已验证的 published tgz 取 hash，而不是源码构建替代品。
- 保留 hoisted/pnpm 路径、唯一 reachable 实例、root containment、混合版本/修改文件拒绝。CLI inspect/configure/strict-noop 必须与库一致。

退出条件：rc.2 正例通过；0.1.5 RC、0.1.7-rc.1、0.1.7 正式版、未来 RC、混合图和版本正确但字节被改均不受支持。`allow-version` 不能让 Guard host-lock 变绿。

### P2：Agent 初始化、注册与卸载

主要文件：`src/runtime.ts`、`src/commands/context-guard.ts`，生命周期测试及所有手工触发初始化的 fixture/probe。

- 用 `agent/created` 替换旧监听；遵循 `undefined | Promise<undefined>` 回调约定。初始化失败向宿主返回清楚错误，不能留下一半注册却报告保护开启。
- 真实 `AgentRegistry.register()`/factory 需要等待；测试不再依靠同步调用假处理器来模拟就绪。
- 新会话 T0 保持安静，不写 Guard notice、不污染空白会话。T1 仅对真实 root input 注入；resume/compact 的恢复原因和去重保持准确。
- 处理初始化取消、重复 attach、销毁、同一 Agent 的 disable/re-enable、配置重载。检查通过 `agent.ctx` 注册的 tool、guard、observer disposer 是否确实归插件所有；若不会自动清理，显式收集并在 owner dispose 时移除。
- 动态启用时覆盖已经存在的 Agent；先核实上游有没有创建事件重放。没有时用 rc.2 支持的 registry 枚举接入一次，不冒用 startup/resume 来源，不重复注册。
- `agent/created` 内禁止等待 `agent.whenIdle()` 或自身 owner disposal，避免 serial 初始化死锁。

退出条件：首个模型请求看见完整工具/guard；工具集合恰好一份；插件禁用后无残留拦截，重新启用后恢复；失败/取消无泄漏。

### P3：Session V4 与会话证据

主要文件：`src/domain/session-events.ts`、`host-workdir.ts`、`digest.ts`、`derive.ts`、`delivery.ts`、`src/core-v2/session.ts`、`src/raw-replay.ts`、`src/domain/private-ledger.ts`、`src/tools/{observe,evidence}.ts`。

- 删除生产逻辑中硬编码的 V3 前提，用目标宿主常量/明确 V4 合同统一校验。`host-workdir` 与 `sessionHeaderForDigest` 必须计算相同会话引用。
- 原有 `snapshotSessionEvents` 继续校验数组与连续事件 envelope。保持单一入口；禁止异常时返回空事件数组并推导成“已完成”。不新增同步历史读取 wrapper。
- 对既有同步读取建立调用清单，说明其在精确 rc.2 中仍合法可运行、未来迁移未承诺。若实施中发现必要的新读取，优先使用现有投影/当前事件或受限异步读取；不要为这次升级重写整个核。
- 验证新 `developer/message`、tool-addition/removal、`headerSeq`、request/context 变化不会成为 root、effect 或 acceptance。保留宿主未知必需事件校验与 Guard envelope 校验的原有分工。
- 用真实 V4 Session/fork builder 构造 open-turn fork、compact/resume、重启及持久化往返；`forked`/interrupted turn 不生成普通 delivery。
- 保持摘要算法及现有黄金向量不变；增加 V4 输入和迁移隔离的产品测试。若确需改共享字段/算法，按独立契约变更处理，不能顺手更新镜像来让测试通过。
- 旧私有 ledger 的 host/session context 不匹配要保留并准确诊断；测试普通工作与严格 release 路径受到的影响不同。

退出条件：真实 V4 正例可闭合；损坏/未持久化/错误身份/子代理继承/旧证书不能闭合；恢复仍与 prepare/checkpoint 一致。

### P4：Jobs、shell 结果与文件观察

主要文件：`src/runtime.ts:readExternalOperation`、`src/domain/evidence.ts`、`host-workdir.ts`、`host-resolver.ts`、`src/tools/observe.ts`、`external-operation.ts`。

- 将 Jobs 调用改成 rc.2 的真实类型和会话 ID；上游工具使用 `exec.agent?.id`。验证它与当前 Session 的身份一致，避免 `unknown as { get(..., Agent) }` 掩盖错误。
- 同 owner 任务可读取；跨 owner、错误 job ID、已删除、服务缺失/抛错保持 unavailable/unknown。保留 running/stopping/completed/failed/killed 的含义，不把状态读取失败判为可等待。
- 单独建前台终结、显式后台、超时 promoted 三类结果。尽可能用宿主真实持久化的可信结构字段；若只能使用文本，必须绑定审计过的 renderer，并识别标记后仍有说明的结构。
- promotion 的部分 stdout 即使出现 PASS 或 `[exit code: 0]` 也不能关闭本次任务。原始 call、job id、owner、终结结果和独立状态回读必须形成同一目标链，才能用于后续认证；做不到则保持未认证，不重跑业务。
- 重审 `[stopped: ...]`、sandbox runner failure、输出丢失/spill/truncation、取消、非零退出的结果；不要由 `isError=false` 推导进程成功。
- 重审省略 workdir 与显式 workdir、本地文件 provider、符号链接和 Windows 路径。保留“原始调用+已审计 provider+当前 session+相同目标”的证据门槛。
- PTC 的子调用保持 rootCallId/parent 归属，不因新 `ptc-runtime` 或并发顺序将外层成功复制给每个子调用。

退出条件：成功正例仍可认证；后台未完成、错 owner、失败、截断不明、远端未知 provider 均不误通过。审批/host 工具行为不由 Guard 另起一层重复决定。

### P5：Goal、动态工具与宿主功能组合

- 在真实 rc.2 ToolRuntime 上验证 `tools.guard` 仍单调拒绝，后续 waterfall 的 allow 不能覆盖 Goal complete 拒绝。
- 显式 Goal 启用/缺省未启用分别测试；证书缺失或 flush 失败时 complete 被挡住，证据齐全时允许；resume/compact 后 continuation/disarm 不变成自动完成。
- 动态安装/启停 Guard 或相关工具后，同会话下一次请求的工具集合与实际 registry 一致；新增工具的 developer 通知不重设工作单元、覆盖用户禁止或重复恢复。
- Auto review 拒绝、审阅失败、人工确认、取消分别记录实际工具结果；UI 显示文案及 `displayReason` 不产生权限或完成事实。
- 对 scheduler/subagent/plugin 注入至少做来源负例；本版不承诺计划任务的端到端业务认证。

### P6：原生验收入口与说明更新

主要文件：`scripts/native_acceptance.py`、`native_host_acceptance.py`、`native_host_probe*.mjs`、`native_release_fixture_v070.mjs`、关联 schema/单测、`UPSTREAM_API_AUDIT.md`、README 中英文、两份 changelog、兼容/host-lock/验收文档。

- 修改真实 native composition、V4 日志路径/读回、等待 Agent 就绪的时序与 rc.2 CLI 参数；参数以目标发行版 `--help`/源码为准，不猜测旧参数仍有效。
- 原生入口保留当前 versioned annex 接口；若新增字段/必修 gate 改变语义，显式升级 schema 并更新全部生产者/验证者，禁止通过手写 transcript 替代。
- `UPSTREAM_API_AUDIT.md` 以 rc.2 为当前适配表，清楚标明同步读取仍是既有 deprecated 依赖、尚未实现的远端能力与 restart 认证限制。
- 文档先说明用户须升级到 rc.2、安装插件并重建 host-lock/重启，再解释诊断。历史 release 文档保持历史原文；当前 README 与兼容声明只写 rc.2。
- 0.7.1 recovery 修复、普通工具职责和显式 proof/release 限制保持可读。不能宣称新 DSH 默认包含 Inspector、Goal 或定时能力。
- 更新 `validation-map.json`、修复家族列表或测试入口，让新增文件参与相应检查；测试仅换名字但未走新生命周期不算覆盖。

### P7：源码候选与精确制品

- 完成下节矩阵；有限审查聚焦 U01–U12 和验收 A01–A16，不另开无边界功能审查。
- 冻结最终插件版本、包文件清单、文档、manifests 和 committed `dist/`；运行完整候选检查。
- 在后续获得相应提交/远程操作授权后，检查 exact-commit CI。未授权时交付本地候选与待执行门槛，不自行推送。
- 从 clean source 用仓库 canonical packer 生成一次冻结集合：tgz、`SHA256SUMS.txt`、`release-artifact.json`；重复 pack 仅用于确认相同输入的字节确定性，不在不同平台重打包。

### P8：原生与发布交接

- 先用当前仓库 versioned native entrypoint 的 `--preflight` 检查版本、输入 identity、能力和路径，再启动隔离 macOS/Windows 验收。
- 两个平台使用相同冻结 tgz，分别验证 Web/Headless、安装、严格第二次 no-op、package parity、host-lock 读回、真实 loaded tools/guard、持久化恢复、Web restart、shell shim 与清理。
- 真实模型最小场景覆盖：普通文件修改+测试+回答；中途 compact/resume 后继续剩余工作；前台转后台后等待真实结果；证据齐全/不全的显式 Goal complete。使用临时资产，不重放用户历史业务，不借生产发布验证。
- 没有某平台、登录或模型执行条件时，记录 pending 的具体 owner/恢复条件；不能把 capability skip 算作通过，也不因此阻止已授权的独立源码工作。
- 发布、日常 Profile 升级和 codex-sync 消费者登记需要后续用户授权；这些不属于本次“写开发计划”的完成条件。

## 6. 验收矩阵

| ID | 场景与独立期望 | 最低证据层 |
| --- | --- | --- |
| A01 | 支持声明仅 rc.2；旧 RC/未来版本/混合图/错 SRI 拒绝；目标完整图成功 | 元数据、真实包图、host-lock 单测 |
| A02 | `agent/created` 完成后才有首个请求；init 失败/取消不留下工具，空白会话无多余 notice | 真实 AgentRegistry/ToolRuntime composition |
| A03 | 同一 Agent 的安装、禁用、再启用、卸载无重复 tool/guard/listener；已有会话动态生效 | composition + 原生 Web |
| A04 | V4 新会话/恢复/compact 具有稳定且真实的会话 digest；V3 header 不作为 V4 接受 | Session 构造/持久化往返 |
| A05 | fork open turn 的 `forked` 关闭不能当正常完成，父/子证据不能交叉认证 | 真实 fork seed + 投影 |
| A06 | developer/tool registry/scheduler/plugin/subagent 事件不造 root 权限、不造 effect、不重复恢复 | 新事件 fixture + 注册入口 |
| A07 | 前台无失败标记的真实正常退出可闭合；非零/取消/runner failure 不通过 | 审计 renderer + 真实 shell |
| A08 | 超时 promoted 即使 stdout 含 PASS/exit 0 仍未终结；完成后同 job/owner/目标的真实终结与回读才可闭合 | bash 与 pwsh；真实 Jobs |
| A09 | Jobs caller 使用 SessionId，同 owner 可读，错 owner/未知/删除/抛错不变成 running | 真实 JobsLocal + Guard reader |
| A10 | 省略 cwd 的本地正例可认证；错误 provider、远端路径、错 session、篡改模块字节拒绝 | workdir observer + active graph |
| A11 | write/edit/read 和 PTC 子调用保留目标/来源关联；外层 success 不能替代子调用失败 | 已注册工具 + 持久化事件 |
| A12 | ordinary 模式与 0.7.1 recovery/prepare/checkpoint 一致；不索要已完成测试，不让证据不足触发重复业务 | 既有 recovery 家族 + 新 V4 组合 |
| A13 | Goal 缺失正常退化；complete 有证书允许、缺证据或 flush 失败拒绝；单调 guard 不可覆盖 | 真实 Goal/ToolRuntime |
| A14 | rc.2 已迁移旧会话：历史证书/ledger 不重签、不删除、不升级当前权限；普通继续仍可行 | 迁移 fixture + 隔离原生恢复 |
| A15 | 两平台的 Web/Headless 同一 tgz 安装、strict-noop、parity、host-lock、restart/cleanup 可读回 | versioned native annex |
| A16 | 最小真实模型业务能继续、等待并正确结束；单元/人工注入探针不能替代此项 | 原生模型执行独立记录 |

建议新增聚焦测试文件 `v080-rc017-{host,lifecycle,session,jobs,shell,hot-reload}.test.ts`，也可按现有目录约定拆分；文件名不是验收标准。优先修改现有拥有对应不变量的测试，再增加未覆盖场景。

现有优先复用：`v051-host-version-production`、`v051-dsh015-adaptation`、`v051-activation-order`、`v051-goal-lifecycle-composed`、`v051-host-loop`、`v051-wait-lifecycle`、`v041-session-events`、`v070-structured-host-error`、`host-workdir-v070`、`native-file-v2`、`persistence-control-v6`、`v6-recovery-feedback`、`private-ledger-v070`、`tools/external-operation`、`tool-surface`、`artifact-entry` 及 native Python 测试。保留其行为断言，替换掉只认识旧生命周期的假实现。

## 7. 检查命令与证据失效规则

修复时先最小 reproducer 和 owning Vitest 文件；同一不变量再次漏修，合并入口×字段×状态检查，不反复跑全矩阵。`node tests/run-repair-families.mjs --list` 选择已存在的家族，按本次风险扩展，不能用 named bundle 替代最终候选检查。

最终本地候选至少执行仓库 AGENTS 规定的完整矩阵：

```sh
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run test:release-pack
pnpm run test:stats
pnpm run build
pnpm run pack:check
python scripts/audit_repository_documentation.py .
python -m unittest discover -s tests -p 'audit_repository_documentation_test.py'
git diff --check
```

上面 `python` 指已验证的 Python 3.11+ 解释器。自动串行运行时启用 shell 的失败传播。更新生成物后必须确认重复 build 不再变化；当候选 `dist/` 已提交/应当最新时执行 `git diff --exit-code -- dist`，不能撤销正确生成物去满足旧 HEAD。

另按改动执行 mirror/conformance/digest 与 native entrypoint 单测。共享算法、schema 或镜像变更才触发对应跨语言产消链重验；仅传入 Session `version:4` 不自动要求改共享契约。保留已通过的相同输入证据，提交/打 tag 不是重跑无关测试的理由。

CI portability 按本仓库现有 Ubuntu/macOS/Windows × Node 22/24 策略，在 exact main candidate/manual dispatch 上通过；它不能替代原生宿主运行。

原生命令模板（实际参数由更新后的入口 `--help` 核对）：

```sh
python scripts/native_acceptance.py --gate-profile host_bound \
  --repo-root <clean-candidate> --runtime-root <exact-rc2-runtime> \
  --web-cohort <registered-rc2-core-id> --headless-cohort <registered-rc2-core-id> \
  --web-market-version <exact-version-or-none> \
  --artifact <frozen.tgz> --artifact-sha256 <sha256> \
  --source-commit <full-commit> --output <unused-outside-repository-annex.json> \
  --preflight
```

preflight 通过后移除该 flag 执行；结果路径和 transfer receipt 用不同且未使用的路径。官方 plugin manager 不能直接当作旧 dshmarket；没有对应 market 就显式 `none`，不能虚构版本。宿主自行重启的验收不等于 Guard 已能认证 market restart。

包内容或 `gitHead` 变化均产生新的制品身份。准确区分源码检查、CI、npm 字节、安装、加载、真实模型、发布与公开回读。发布准备完成后如获授权，使用已验收 tgz，读回 tag、registry integrity、下载 tgz、嵌入 gitHead 与 Release target。

## 8. 待实施核实事项与停止规则

| 事项 | 当前证据边界 | 关闭方式 |
| --- | --- | --- |
| rc.2 实际 Web/Headless 关键图及包数量 | 已读 36 项 Registry 元数据，未安装审计 | P0 解析两种 composition，列出增删及真实 bytes |
| 插件热卸载的 effect ownership、已有 Agent 接入 | 上游已改框架行为，当前 Guard 注册所有权尚未动态验证 | P2/P5 实测，必要时显式 disposer 与枚举接入 |
| promotion 到终结结果的可认证链 | 已证实上游可后台化；Guard 端尚未接线测试 | P4/A08；链不全则明确保留 unavailable，不伪造正例 |
| 迁移后旧私有 ledger 的用户诊断 | 现有 digest 绑定 header/host；新 context 必然需要严格区分 | P3/A14 保留历史、准确诊断，不自动 reanchor |
| 原生平台和真实模型可用性 | 本轮未运行 | P8/A15/A16 单独留证；无条件时明确 pending |

开发完成条件：P0–P6 实现及 A01–A14 满足，完整确定性检查通过，无开放的可复现身份/权限/错误完成 P1，文档与包声明一致，`dist/` 当前。此时可称“源码候选完成”。

“精准适配 rc.2 已验收”还要求 P7/P8 和 A15/A16 的精确制品与原生证据。未完成这部分只能报告具体覆盖范围，不能宣称所有宿主/模型行为已通过。外部发布与日常安装按后续授权执行，分别报告。

新复现的权限提升、错身份认证、数据损坏或错误完成是阻断项；不相关 UI 优化、全部异步读取重构、完整远程/调度功能属于后续工作。完成既定门槛即可交付，不无限增加审查维度。

## 9. 给下一会话的执行提示

可将以下内容作为新会话任务，按需要另行补充提交、推送、安装或发布权限：

> 请按 `docs/DEVELOPMENT_PLAN_DSH_0_1_7_RC2.md` 实施 DSH Completion Guard 对 DSH 0.1.7-rc.2 的精准适配，并读取配套 planning-evidence.json。先刷新仓库基线与上游身份，保留无关工作；仅支持 rc.2，不保留历史宿主 fallback。按 P0–P8 推进可执行的工作，优先关闭 lifecycle、Session V4、Jobs SessionId、shell promotion 和宿主字节审计问题，保留 0.7.1 恢复反馈与既有 proof/Goal/release 边界。逐项返回 A01–A16 的证据状态与未完成条件。不要把本计划视为日常 Profile 变更、Git 推送或发布授权。
