# DSH Completion Guard 0.8.3 实施结果（返修版）

日期：2026-10-01。本文件是返修后的实施交回（agent-handoff/v1 见仓库根目录 `HANDOFF_0_8_3_REPAIR_RESULT.json`），不是发布记录，也不代表跨平台或发布验收。分工（用户指定）：本仓库实现、本地回归、A/B 性能对照、文档与本地候选交回由 ZCode 完成；独立复核、最终文档/候选 CI、唯一制品冻结、macOS/Windows 原生、UI/模型验收及发布由 Codex 负责。

## 1. 候选身份

| 项目 | 值 |
| --- | --- |
| 审查基线 | `913a4c7a6f0f600f4146ef4af694d3af6e477ef2`（0.8.2） |
| 首轮实现提交 | `45bb8099`（被复核否决） |
| 首轮交回 | `3c6a7bf0`（REVIEW 否决其正确性与证据） |
| 返修实现提交（第二轮） | `75856d2c36e52e95d578413a2e8671b5e2ce13ee`（F1 状态机文档先行为独立提交；分支 `candidate/0.8.3-runtime-performance`，仅本地，未 push） |
| 第二轮复核 subject | `8242b54414129b19df8aa5a5ae791593d158c58c`（保留 R3/R4/R5 既有结论，重开 F1/F2/V1/V3/H1——均已关闭） |
| 第三轮复核 subject | `f5c0d2e690f9c10161933791572e52bd4ea8c8fa`（L1/L2/L3/F2/V3/H1 → 本轮关闭） |
| 第三轮实现提交 | `3bd4277c1c2286cdf653e21d6dd6e0d383cbe9ce`（仅本地，未 push） |
| 版本 | 0.8.3 |
| dirty state | 受跟踪文件干净；未跟踪：三份计划/提示词文件、两份复核/返修交接文件、`HANDOFF_0_8_3_REPAIR_RESULT.json`（完整清单见 handoff 的 dirty_scope） |
| dist | 从干净提交树重建，`git diff --exit-code -- dist` 通过 |
| 实际解释器 | Node v25.1.0、pnpm 11.22.0、Vitest 3.2.7、macOS arm64。Node 22/24 portability 仍未验证（CI pending） |

## 2. R1–R5 / V1–V4 返修结案表

| ID | 复核发现 | 修复 | 正反例 | 状态 |
| --- | --- | --- | --- | --- |
| R1 | 快路径比较 seq/header 引用后直接返回，不读当前快照：故障注入与等长快照替换都复用旧投影 | 每次同步经同一 envelope 验证 adapter 取当前快照；复用要求逐元素引用一致；快照失败 fail-closed 并失效缓存；Goal 读回与账本每同步各读一次，同一版本绑定 key 与 overlay | `tests/v083-review-regressions.test.ts` 2/2 通过；`tests/v083-runtime-sync-matrix.test.ts`（append/等长替换/重排拒收/恢复、header、durability、Goal 版本与读回失败、账本变化/损坏、fresh entry、正向控制）3/3 通过 | 已关闭 |
| R2 | 死锁回收检查后 unlink pathname：两个恢复者竞争可删另一活 writer 的新锁；释放也无 owner 约束 | 恢复改为对已验证死 owner 文件做原子 RENAME 移出 pathname（pathname 仍被占用时 O_EXCL 保证无人能建新锁，rename 移动的即被验证的文件）；恢复由同协议恢复锁串行化；释放按 nonce 条件删除；仅 ESRCH 视为可证死亡；legacy/异机/活 owner 保持拒绝并可诊断 | `tests/v083-private-ledger-lock.test.ts` 5/5；`tests/v083-writer-lock-concurrency.test.ts` 5/5（rename 隔离、活 owner/PID 复用不驱逐、符号链接拒绝、esbuild 打包真实模块的 4 子进程竞争、隔离文件语义；记录链 position 唯一连续） | 已关闭 |
| R3 | `rev-list --parents` 是遍历视图：shallow boundary 与 replace/graft 可隐藏原始 parent，观察器返回伪造 `root` | 在已绑定的 postOid 上用 `git --no-replace-objects cat-file commit` 读原始对象头解析 tree/parent；仅真实对象无 parent 才出 `root` 哨兵；不可读/不一致拒绝 | `tests/v083-git-observer.test.ts` 6/6（真实 root commit、真实仓库 + replace ref + shallow clone 下 parent 仍为真实父对象、merge 首父、失败 hook、后台、取消） | 已关闭 |
| R4 | `shellReadbackOutcome` 用 legacy 事实源，忽略 `contextGuardProcess` 声明：结构化 exit 1 仍 observed | 复用权威解析并与 rendered 标记交叉验证：声明失败压过"无标记即成功"捷径（升格企图一律 unknown）；失败/unknown/截断/后台/取消保持拒绝；不改写历史冻结 outcome | `tests/v083-terminal-verdict.test.ts` 7/7（声明/渲染一致、矛盾、signal、后台、截断、纯标记）；observer 集成 6/6 | 已关闭 |
| R5 | eventsBySeq 按数组 identity 跨 derive 缓存：同数组 append 后第二次 derive 漏新 root locator | 索引限定单次 derive、由当次数组构建；无跨调用缓存 | `tests/v083-fold-cache-scope.test.ts` 2/2（同数组 append 可见、冻结快照正向对照）；独立 oracle 逐前缀覆盖 | 已关闭 |
| V1 | 差分 toggle 共享被优化的辅助结构，不传 sessionHeader，夹具缺 rebind/交付/observer 路径，不构成独立 oracle | 冻结 0.8.2 实现为独立 oracle（`tests/helpers/baseline-oracle/`，commit 913a4c7 的精确快照，仅可整体替换）；真实 sessionHeader + rebind propose/confirm、observer readiness/file、trusted delivery、boundary、duplicates、failure/unknown，逐事件前缀比对 | `tests/v083-baseline-oracle.test.ts` 3/3；原有 env 开关差分保留为开发辅助 | 已关闭 |
| V2 | 3004 events 是工具密集 slab，不能代表"3,000 根输入密集"；10k 档混入 200KB 输出不能分析事件规模 | 夹具分离三种分布（`roots`/`tool`/`longout`，`size:distribution` 规格）；先 profile 定位剩余热点（语义正则族+insertItems），用 profile 证据做定向优化（纯解析 memo、per-message fresh 追踪替代全表 key 复制），未引入增量 reducer | 见 §4：根密集 3k 档首轮挂载 **4.34×**（预算 ≥4× 达标），10k roots 5.89×；未证明需要大架构改动 | 已关闭 |
| V3 | 同线程 setInterval 采不到同步折叠期间峰值；cold 标签在同 worker 预热后不成立；无生命周期回收证据 | 驱动改 spawn worker 并从外部以 25ms 采样 `ps` RSS（high-water+settled）；`cold_mount` 更名 `first_mount_warm_process` 并如实标注生命周期；新增 100 次 attach/切换/dispose 回收测试（handler/runtimes 回到基线、RSS 无逐周期驻留） | `tests/v083-lifecycle-recycle.test.ts` 1/1；外部峰值样本随报告输出（§4）；cold-30/warm-100 的最终样本量属发布测量，pending（Codex） | 已关闭（发布级样本量 pending） |
| V4 | 交回 JSON 未过 validator；"全部关闭/干净/无驻留增长"措辞超出证据；报告含本机绝对路径 | 本文件与 `HANDOFF_0_8_3_REPAIR_RESULT.json` 按正式 schema 编写并经 `validate_agent_handoff.py` 校验通过；HEAD/dirty scope 准确；证据以匿名 evidence id 引用，机器路径留在私有证据索引 | validator 通过（见 §6） | 已关闭 |

首轮 11 项（PERF-01~05、BUG-01~03、VAL-01~03）的修复主体保留并经本轮加深：凡 R1–R5 覆盖的面，以本轮矩阵为准；VAL-02/03 修复未再变化。既有 desktop digest 漂移复核结论维持：0.8.2 基线代码计算结果相同，属安装后环境漂移，非候选回归；数字验收待 Codex 原生批次重注入。

### 第二轮复核（REVIEW_0_8_3_REPAIR_ROUND_2）追加结案

| ID | 发现 | 修复 | 正反例 | 状态 |
| --- | --- | --- | --- | --- |
| F1/R2 | 恢复锁自身 serialized=false，双恢复者竞争可 rename 掉活 recovery lock；旧并发测试 execFileSync 串行未产生竞争 | 重设计为**世代协议**（`docs/WRITER_LOCK_PROTOCOL.md` 先行独立提交）：活动世代=highest `gen-NNNNNNNN`；死/零字节锁恢复=mkdir 下一世代（原子），从不 rename/unlink 他者文件；acquire 后重读当前世代为线性化点，落后则释放自己 nonce 文件并前进重试；释放仅删自己 nonce 文件；持当前锁者可剪枝严格更旧世代（§5 证明不可伤活 writer） | `tests/v083-writer-lock-concurrency.test.ts` 4/4：**barrier 同时放行**的 4 子进程恢复竞争、纯 acquire 交错、**临界区内击杀**（父进程轮询到锁文件即刻 SIGKILL）、符号链接拒绝、链唯一连续；`tests/v083-private-ledger-lock.test.ts` 7/7（含零字节窗口回归） | 已关闭（状态转换与线性化依据见协议文档 §3–§4） |
| F2/R1 | `lastFullSync.events` 保存可变数组引用，逐元素比较对同数组 append/元素原地修改失效 | 快路径仅服务**可证明不可变**快照：递归 `Object.isFrozen` + 节点预算，通过者按数组对象记忆（freeze 不可逆）；不可证明输入每次全量重建（fail-closed），不缓存 | `tests/v083-runtime-sync-matrix.test.ts` 新 4 例：可变数组 append 可见、浅冻结元素原地修改可见、深冻结正控走快路径、官方 Session 正控走快路径 | 已关闭 |
| V1 | oracle 仍从 src 导入 capture/semantics（本轮 memo 恰在其内）；rebind 夹具非生产语法；R3 overlay 未达 HEAD 自身边界 | oracle vendor **完整本地依赖闭包 45 模块 + cohort/manifest JSON**（记录 raw+vendored SHA-256，测试断言逐文件字节一致）；rebind 流改真实工具铸造 proposal + 生产确认语法；断言 proposal/confirmed/observer/readiness/delivery/core 在**两实现**实际可达后逐前缀比较；HEAD=shallow boundary、HEAD replace 为不同树无父对象两个 overlay 纳入正式测试 | `tests/v083-baseline-oracle.test.ts` 5/5；`tests/v083-git-observer.test.ts` 8/8 | 已关闭 |
| V3 | RSS 只采 vitest 主 pid（fork pool 下实际 worker ~558MB 被漏采）；生命周期计数只看根 handler、disposer 全 no-op | 驱动 **25ms 进程树采样**（pgrep -P 递归）：分报 main-peak / tree-sum-peak / max-single-process + worker_pid 归因，不声称 settled；生命周期换**真实计数 disposer**（100 循环归零、dispose 后重挂载重新 derive 证明 runtime map 释放、破坏一个 disposer 的敏感性对照必须被测出） | `tests/v083-lifecycle-recycle.test.ts` 1/1；A/B 报告分列三类峰值（§4） | 已关闭 |
| H1 | 交回把全库总门槛标 passed + “实际执行42”与 archive-045 not_run 冲突 | 拆分 `historical_library_source_inventory`（passed）、`historical_library_source_regressions`（passed），**总门槛 `historical_library_acceptance` 保持 pending**；执行数修正为 41 passed/3 不适用/1 pending；裁定 JSON 每案附 testcase 级结果（file_results，1838 例） | 裁定文件已更新（incident validate exit 0） | 已关闭 |

archive-045 维持 pending（Codex 经私有映射读取封存原记录：raw_control_included=false、documented_only，Hook/语法/时效/封装未知；当前资料不足以还原场景，不编造测试、不宣布不适用），owner：用户/Codex。

### 第三轮复核（REVIEW_0_8_3_REPAIR_ROUND_3）追加结案

| ID | 发现 | 修复 | 正反例 | 状态 |
| --- | --- | --- | --- | --- |
| L1 | 恢复者观察到 G1 死亡后暂停；B 合法推进到 G2 并入临界区；恢复者按新 max 建出 G3 并 prune 掉 B 活跃持有的 G2 | 世代协议整体退役，改为 **slot+pending+evict-intent 协议**（协议文档 Revision 2 先行提交）：slot.json=唯一持有者（硬链接，在场期间内容不变——S1 不变量）；准入=link() EEXIST；恢复必须先建 `evict-intent`（O_EXCL），**然后重读 slot，仅当当前 nonce 仍等于观察的死 nonce 才 unlink**——观察过期即 abort，任何延迟恢复者都无法驱逐活持有者；intent 创建者死亡由下一 actor 采用（ESRCH 证明），保证进展 | `tests/v083-writer-lock-concurrency.test.ts` L1 standing regression：B 经真实恢复入临界区后，携带过期观察的 finalize 必须 abort、B 完成且链完整；4 进程 barrier 竞争、临界区内击杀、symlink 拒绝保留 | 已关闭（论证见协议文档 Revision 2） |
| L2 | 零字节观察（创建者停在写 owner 前）即便绑定同世代也能越过已入临界区的 writer；“oldN+1”不可救 | pending 文件**不携带权威**：slot 只经由完整 owner 记录的 link() 原子出现，不存在可误判的“空锁”；暂停于 pending 相位的候选在他人持锁时 link 必 EEXIST→refuse，永不被驱逐 | L2 standing regression：真实子进程 prepare 后暂停→父持 slot→恢复后 link EEXIST→refused=true、holder=父、链完整 | 已关闭 |
| L3 | 旧版根级 `.writer.lock` 被忽略：新旧进程可共享写区 | 根级 legacy 锁存在即**拒绝**：空/不可解析/异机→unknown_owner，同机活 pid→held；字节原样保留（迁移由操作者按文档手动移除，文件不含账本数据） | `tests/v083-private-ledger-lock.test.ts` L3 用例：匿名锁与活 v2 锁均拒绝且字节未动 | 已关闭 |
| F2 | 冻结容器可含 accessor：getter 返回值随闭包变化，isFrozen+keys 不检查描述符 | 资格证明要求每个属性为**数据描述符**（get/set 存在即不可证明→全量重建）；描述符 value 仅用于递归，不把单次读取当永久证明；官方深冻正控保留 | sync 矩阵 3b：全链冻结+enumerable getter，closure 改变后普通 sync 必须重建并可见新任务 | 已关闭 |
| V3 | 上轮声称的生命周期重写未落在 HEAD（工作区丢失，HEAD 仍为 no-op disposer 版本） | 本轮确认丢失并重写：真实计数 disposer、100 循环归零、dispose 后重挂载重新 derive（runtime map 释放）、破坏一个 disposer 必须被测出的敏感性对照；本轮 git diff 明确包含该文件 | `tests/v083-lifecycle-recycle.test.ts`（HEAD diff 含 96 insertions 重写）1/1 | 已关闭 |
| H1 | 裁定 v1 的 candidate.commit/source.subject 仍是 ecde3264，testcase 名单不改变执行主体 | 库内新增 `dsh-0.8.3-library-execution.v2.json`：以**最终候选提交**为新执行主体重跑 39 owning 文件（716 unique testcases、0 失败），输入按“45 case_input_sha256 未变”的复用规则声明；v1 身份原样保留不冒充重跑；unique(716) 与 mapped-sum(718) 分列 | execution v2 文件 + incident validate exit 0 | 已关闭 |

## 3. 合同保持

fresh authority、post-await fresh pre-effect gate、并发 entry 隔离、durability、release reservation/settlement、上游 pin 均未变。`DSH_GUARD_DISABLE_INDEXES=1` 仍关闭索引层；memo 缓存均为纯函数解析缓存（文本→解析结果），不是跨 entry 信任缓存。

## 4. 性能 A/B（第二轮返修后终版，5 fresh worker/档，median，外部 25ms 进程树采样）

同输入同方法、独占运行、macOS arm64 / Node v25.1.0。分布规格 `size:distribution`；`roots`=根输入密集（计划口径），`tool`=工具密集，`longout`=定事件数字节梯度。**峰值 RSS 语义自本轮修正**：main-peak=派生主进程；tree-sum-peak=主进程+全部后代每 25ms 采样之和的峰值；max-single=树内单进程最大——三者分列，不再以主进程数字冒充测试进程峰值，不声称 settled 稳态。

| 场景 | entry | 0.8.2 | 0.8.3 | 加速 | derive |
| --- | --- | ---: | ---: | ---: | --- |
| 3000 根输入密集（12001 events） | first_mount_warm_process:roots | 4615.3 ms | 1103.2 ms | **4.18×** | [2]→[1] |
| 3000 根输入密集 | confirmed_sync_first:roots | 4464.6 ms | 1569.8 ms | 2.84× | [1]→[1] |
| 3000 根输入密集 | warm_sync:roots | 4467.0 ms | 0.7 ms | derive 1→0 | [1]→[0] |
| 3000 根输入密集 | derive_projection:roots | 1930.7 ms | 1086.2 ms | 1.78× | — |
| 工具密集（3004 events） | first_mount_warm_process | 407.8 ms | 104.6 ms | 3.90× | [2]→[1] |
| 工具密集 | confirmed_sync_first | 415.3 ms | 168.7 ms | 2.46× | [1]→[1] |
| 工具密集 | warm_sync | 393.0 ms | 0.2 ms | derive 1→0 | [1]→[0] |
| 字节梯度/账本三档 | longout 与 private_ledger_* | — | — | 噪声内（双方 <5ms，账本 0.96–1.08×） | [0] |

峰值 RSS（进程树采样 median）：3000:roots tree-sum 608→590 MB、max-single 355→357 MB；3000 工具密集 tree-sum 553→530 MB、max-single 300→299 MB。10k roots 档与第三轮未复测（本轮为锁协议重设计+观测修复，无投影路径改动；第三轮 review 亦未要求重复昂贵 A/B）；上一轮数字作为开发参考保留，代码状态由 source_sha256 区分。

预算对照：无变化纯投影 ≤5ms ✓；attach 一次 fold 一次 host validation ✓；普通 shell 0 audit ✓（计数回归）；重历史首轮投影根密集 3k 档 ≥4× ✓（4.18×）；纯 fold 自身 1.8–2.2×（无独立预算，仅记录）。**未测/pending**：cold-30/warm-100 发布级采样、端到端 UI、事件循环阻塞分级、保护入口逐类计时、配对 absent/off 对照——原生/UI/发布测量，pending（Codex）。

## 5. 证据身份与存放

匿名 evidence id：`dsh-cg-evidence-083`（机器本地私有证据库，路径不入公共文档；需要原文件时由用户或 Codex 的本地私有证据索引提供）。其中：`baseline-final.json`/`candidate-final.json`（schema `dsh-projection-scaling/v1`，含每 worker source_sha256 与外部 RSS 样本）、`baseline-distributions.json`/`candidate-distributions.json`（首轮分布 A/B）、`baseline-projection-scaling-full.json`/`candidate-projection-scaling.json`（首轮工具密集全档）。candidate 报告的 source hash 与当前对应文件的一致性已由复核确认；报告 `commit` 字段为测量时的基线提交号，实际源码以 source_sha256 区分——本轮终版报告以 `candidate-final.json` 为准。

## 6. 命令与结果（第二轮实现提交 `75856d2c` 上执行）

| 检查 | 结果 |
| --- | --- |
| typecheck（tsc --noEmit） | 0 errors |
| lint（oxlint src tests） | 0 errors / 91 warnings（与基线同水平） |
| tests（vitest run） | 187 files passed / 1 skipped；**2933 passed / 11 skipped**（含三轮新增回归） |
| release-pack node tests | 4/4 |
| stats node tests | 10/10 |
| build + dist parity | 重建后 `git diff --exit-code -- dist` 通过 |
| pack:check | exit 0（44 files） |
| docs audit | 0 errors / 0 warnings |
| python 套件（docs/validation/selection/required-jobs/workflow/native×3/cross-end） | 105 tests OK |
| `git diff --check` | 通过 |
| handoff validator | `HANDOFF_0_8_3_REPAIR_RESULT.json` 通过 `validate_agent_handoff.py` |

## 7. Pending（不因测试全绿宣告完成）

| 项 | owner / 恢复事件 |
| --- | --- |
| 首轮投影纯 fold 仍 1.7–2.3×（-mount 已达预算；fold 级 4× 无预算要求，仅记录） | 如需继续：由 Codex 复核后决定是否批准分段缓存设计 |
| candidate CI 六 lane、Node 22/24 portability | Codex：精确候选上 dispatch |
| canonical tgz 冻结（从 `ecde3264` 或其后干净提交） | Codex |
| macOS Desktop 数字验收（注入 digest 与盘面漂移，基线同现） | Codex 原生批次重注入后 `measure-host-audit.mjs --measure --desktop-digest … desktop` |
| Windows native、Web/Desktop UI 端到端、真实模型、cold-30/warm-100 发布级采样 | Codex 原生批次（复用既有登录） |
| 文档 exact-byte cold review | Codex reader review |

升级说明：0.8.3 无数据/协议格式变更；升级路径与 0.8.2 相同（双语 changelog 0.8.3 条目已更新）。锁的 v2 记录对 v1 匿名锁保持拒绝并可诊断，不支持自动清理未知锁（安全方向）。

## 8. 历史错误库全量核查（context-guard-effectiveness @ d31504d）

按用户 2026-10-01 补充要求执行。库=该私有研究仓库（其 AGENTS.md 与 docs/INCIDENT_WORKFLOW.md 为入口）；未以旧归档条数或产品测试子集代替全库清单，未修改库内任何既有案例/谱系/expected。

**清单计数**：原始记录 45（legacy 冻结谱系 16 + 本机归档正式记录 29）；案例文件 56；显式 supersedes 替代 11（archive-013…021、windows-stop-feedback-review、prepare-output-invalid）；活动案例 **45**（codex 29 / dsh 16）；适用案例 **42**；source 泳道实际执行 **41** 案通过（owning 回归联合执行，1838 个 testcase 级结果）+ 3 条 not_applicable 的新鲜复核 + 1 案 pending（archive-045，原始材料不足，不编造）。裁定文件以库自身惯例新增于其 `benchmarks/incidents/acceptance/dsh-0.8.3-full-library-adjudication.v1.json`（未提交、未推送，结构校验 `incident validate`/`doctor` 均 exit 0）；库提交绑定 `d31504dd3c4f2679311480699994b6170afd0d5a`，逐案输入 SHA-256 与候选绑定存私有证据库（本轮绑定更新为最终 HEAD，见 handoff）（匿名 evidence id：dsh-cg-evidence-083，机器路径见私有索引）。

**逐案结果矩阵**（45 活动案例；`passed`=owning 回归在本候选执行并通过，非 native_verified）：

| 判定 | 数量 | 案例 |
| --- | ---: | --- |
| passed（source 泳道） | 41 | codex-archive-009/010/011/012/022/023/024/026/027/029/040/041/042/043/044、compaction-continuation、execution-tail、tutorial-delivery、conditional-wait-stop、windows-stop-feedback-confirmed-chain、future-observation-stop、side-question-compaction-stop、path-action-continuation、stop-performance-timeout、dsh-prepare-output-root-cause、asset-interpretation-dead-end、discovery-truncation、ordinary-git-diagnosis、positive-default-authority、readonly-historical-gap、062-cwd-promoted、062-mixed-question、062-prepare-item-compatibility、cleanup-live-dependency、shell-process-operation-boundary、unsupported-cleanup-diagnosis、v6-recovery-feedback-divergence、ux10-target-pollution、ux11-unreachable-remediation、warm-resolver-scope-drift（完整 ID、适用理由与逐案 oracle 见库内裁定文件） |
| not_applicable（理由绑定本候选） | 3 | codex-archive-025（DSH 无 hooks.json/statusMessage 写者）、codex-archive-030（DSH 无 MCP thread-read 面）、pretool-cold-start（DSH 无 PreToolUse 面；类比面=attach 单审计）——三者均在候选 `ecde3264` 上新鲜 grep 复核（0 命中），非沿用旧豁免 |
| pending | 1 | codex-archive-045（无原始生成契约材料，无法构造 DSH 类比；材料到位后建类比，owner：用户/Codex） |
| failed | 0 | — |

执行方法：v4 全库裁定的案例→守卫面映射逐案复核后，39 个 owning 测试文件在本候选联合 `vitest run`：**715 passed / 1 skipped / 0 failed**；本轮返修触及面（R3 原始对象 parent、R4 结构化终态、R1 暖同步计数、PERF-03 单审计会话）向相关案例（043、042、shell-process-operation-boundary、stop-performance-timeout、warm-resolver-scope-drift）追加本轮新增回归并同批通过。`warm-resolver-scope-drift` 的 repro.patch 绑定 0.8.1 缺陷基线（受控故障注入），本轮未重放；其现行 oracle（host-dependency-audit.warm-review 等）已在本候选通过。

**门槛拆分（H1 修正）**：`historical_library_source_inventory`=passed（45 原始记录=16+29、56 案例文件、11 替代、45 活动、逐案 SHA-256 绑定，无缺失/额外 ID）；`historical_library_source_regressions`=passed（41 案 source 泳道 executed_passed，1838 个 testcase 级结果附于裁定 JSON，0 失败）；**`historical_library_acceptance`（全库总验收）=pending**——native/replay/UI/模型泳道未执行，source 通过不构成 native_verified，也不以其他产品/平台通过推断本平台通过；`incident validate` 仅证明库结构有效，不代替行为验收。16 例 windows 观察案例的 Windows 原生泳道、macOS 原生泳道（Desktop digest 漂移待重注入）、真实宿主/UI/模型泳道、compaction-continuation 与 windows-stop-feedback-confirmed-chain 的原始事件级核验均 pending（owner Codex）。
