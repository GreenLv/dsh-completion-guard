# 下个版本：准备工具、Git 取证与问答残留

状态：局部修复已随 0.5.3 发布（2026-09-14）；本页记录的 0.6.0 语义设计已实现（2026-09-14），0.6.1 修复已实现（2026-09-15），实现状态与验收边界见下节与[语义兼容说明](SEMANTIC_COMPATIBILITY.md)。本页以 0.5.2 为事故修复基线；精确制品与平台结果见[验收记录](LOCAL_ACCEPTANCE.md)。

## 0.6.1 修复（2026-09-15）

对一次真实 Windows 0.6.0 会话的只读回放复核确认了五项缺陷（来源与根因见仓库内 `docs/WINDOWS_0_6_0_REPAIR_PLAN.md`；该计划是本批修复的规划依据，原始材料保留在仓库外）。五项均已从统一解释、能力合同与状态转换层修复，不依赖事故句子白名单，不通过删除未知项或放宽证据校验使测试通过：

- **W060-01 附件解释死路**：非文本根输入按逐资产身份保留为信息义务，其关闭需要**逐资产解释记录**（新入口 `context_guard_interpret`）**加**记录所在 turn 的可信交付，两者缺一不可。记录绑定**调用与结果一致的 turn 对**（调用 turn 随 `tool/call` 记录，重放要求回执 turn 与之相等）；重放在事件自身水位把回执对照合同重新校验（调用 item ID、条目 revision、资产身份）：身份矛盾或 turn 对不一致（中断 turn 的调用、回执被移植进后来回答）记 `interpretation_receipt_mismatch` 完整性违规；身份有效但 turn 关联缺失则仅不产生记录、日志保持 valid。解释 turn 的交付也是旧附件的关闭通路（其根消息已不可能属于活 turn）；仅存在一条 final 不关闭任何未经解释记录的图片义务。在入口存在之前写入的日志重放时附件保持 `pending`（与 0.6.0 相同），只能由当前解释事件关闭。回答交付、视觉证明与执行认证保持分离。
- **W060-02 默认执行语义**：遵循复核最终解释合同——**语法上的陈述句也可以表达任务要求**，任何表面句式都不能证明子句是可关闭的信息。无可解析动作且无**正面信息依据**的子句默认 `unresolved`（保留、可见、永不执行、不被交付关闭；经逐字具体澄清、确认重绑定或 clear 解决，澄清通路已接受 unresolved）。正面信息依据 = 可识别的信息请求形态：疑问句、引用动作、产出物请求、过去/完成体报告，且依据必须**独占整个子句**——信息跨度之后衔接新要求（"Figure out the issue and sanitize all inputs"、"Figure out the issue & sanitize all inputs"、"Explain the issue, sanitize all inputs"）、报告处于定语（"清理已经生成了的缓存"，无长度阈值）或从句（"Sanitize inputs that were supplied by users"）时整句不可判定、保持 unresolved 并保留其中的执行子项。解释/调查开头同样不自动进入可关闭通道。**结构化解释通路已实现，为跨度划分合同**：`context_guard_interpret` 泛化后同时服务资产义务与 unresolved 子句义务——调用方提交 information_spans/unknown_spans 划分，守护程序对照完整输入跨度校验覆盖与关联；**重放把回执绑定到持久化的调用参数并要求二者划分完全一致**，重画划分（把已提交的 unknown 跨度改成 information 声明）即 `interpretation_receipt_mismatch` 完整性违规，不产生记录、不取代任何条目；仅 information 子项由解释 turn 的交付关闭，unknown 与未申报子跨度保持 pending。整项确认回执不产生关闭资格。整句应答（"当然。"）属会话层不捕获。裸英文 wh-词只在子句开头算疑问标记，从句关系词不把真实指令降级。普通祈使句读法不变；仅提及动作的陈述不再释放等待保留。
- **W060-03 发现结果截断**：prepare 的 discovery 改为固定页大小、稳定排序、绑定合同 revision 的 cursor 分页，revision 变化显式失效；`semantic_action` 为唯一声明筛选并随 cursor 携带；v5 会话下列表范围为当前单元闭包加必需后代加 pre-v5 义务。
- **W060-04 只读证据角色不一致**：prepare、诊断与认证器共用同一义务合同——stateful 需要 resolution/effect/state，只读验证需要单条 effect 角色事实；historical-gap 判定仅限 stateful。
- **W060-05 普通 Git 观察事实**：对动作与命令头锚定信号一致、且无可归属生产者证据的义务，诊断为 `execution_unattributable`——该命令是否执行了此动作**无法确立**：只读核实现状、保持未认证、不重做、不断言未发生。Guard 不扫描复合命令文本（引号数据与短路控制流会虚构观察，整体成功不证明分段执行）。受保护 git 链现在拒绝重放已成立的动作：push（远端已在本地 head）、pull（HEAD 已在 upstream）、fetch（tracking 已更新）在执行任何命令前以 `effect_already_applied` 拒绝，动作工具报告 `action_already_applied`——链外执行不能经空转重跑洗白为生产者证据。首次提示的条件化措辞取代对所有 stateful 动作的无条件 Guard 前置要求。

本节初稿曾宣称上一版实现"附件按 turn 交付关闭"与"按段动作观察"；复核以反例否决后已按上述设计重做，反例保留为 `tests/domain/v061-*.test.ts` 常驻回归。

有意排除的范围：action-event 与 state-outcome 义务的显式区分（需要新的公开义务类型与捕获合同，超出补丁版本兼容边界，列为后续独立能力）；`git_tag` 与 GitHub Release producer 路由缺口维持既有 backlog 状态。

0.6.1 的确定性证据边界见[验收记录](LOCAL_ACCEPTANCE.md)的对应小节：它覆盖本地确定性矩阵，不包含也未宣称原生平台验收、精确制品冻结或发布读回。

## 0.6.0 实现结论（2026-09-14）

本页"待设计：问答交付与执行认证分离"一节列出的六项要求已全部落地，并且都在生产链路（derive / 交付 / 闭包 / Goal / 工具注册）上运行，而不是只测解析器：

- 原文跨度按 UTF-8 字节半开区间绑定信息、执行、约束和未知部分；无法分类的部分进入 coverage 记录并保持可见，不由模型摘要替代原文。
- 回答交付记录绑定当前根输入、宿主 turn 与最终回答；判据是宿主的 `assistant/message`（该 turn 最大 step、无 interrupted）+ 后继 `turn/end completed`，交付不代表内容正确或执行完成。
- 混合请求按子项关闭：回答部分交付即关闭，修改/测试/发布仍需独立证据；子项交付不关闭父项全部工作（C04 必需后代闭包）。
- 未知表达保持可解释的未决状态；未通过增加关键词或删除 pending 条目来掩盖问题。
- 延迟回复、子代理回复、压缩摘要、引用历史和中止 turn 都不会绑定为当前回答；子代理结果标记为有界证据，且明确不是可用的证明来源。
- 旧证书、旧投影与升级边界已明确：v5 边界之前的条目保留出生规则，v1 证明 manifest 与全部 v3 摘要域只读不变；新共享行为先以 DSH 侧 host-neutral 候选形式落地。

### 跟进复核后的第二轮修复（2026-09-14）

修复提交的跟进复核在新接线中发现 5 个残留缺陷，均属原家族，已全部修复并保留反例为回归：pre-v5 交付追溯关闭（F01）、真实生产者缺 registry 且 ref 路径不可达（F04）、闭包 revision 使发布依赖发布（F04）、只读 `release status` 永久毒化发布状态（F05/F06）、proof 签发时校验但重放时忽略（F08）。同时补齐了此前缺失的**可信恢复入口** `context_guard_release`（`status` 只读、`reconcile` 按审计 registry 回读结算，绝不重发；覆盖重启后与 revoked-but-in-flight 恢复，并为 SHA256-only 合同保留预约期记录的 SRI 以便核对与检测不一致）。

### 集中复核后的修复（2026-09-14）

对 0dce898 候选的集中复核给出 15 个反例，全部复现真实缺陷；F01–F08 已修复并各有生产链路正负例，反例套件保留为常驻回归（`tests/domain/review-counterexamples.test.ts`）。其中一项复核期望（R1）被有意修改：原探针要求"64 位 hex 契约 + SRI 请求"必须放行，这本身就是被判定为缺陷的身份混用；修复后同义要求由"真实制品绑定的合法发布必须可放行"与"错字节/错 gitHead/错 SRI/错目标/错回读必须拒绝"两组用例覆盖，理由写在测试原位。

仍未完成、且本页不宣称完成的部分：

- 上游尚未落地冻结的 v2 fixture，因此本仓库的 v2 文件是候选身份，跨语言 parity 与正式镜像待上游落地后按精确 commit 重镜像并刷新 `UPSTREAM_PIN.json`。**协调者已于 2026-09-14 裁定阶段性退出**：该项归上游所有，列为跨仓库待办，不作为 DSH 侧退出条件。
- 发布档可保护表面仅 `npm_publish`。`git_tag` 与 GitHub Release 路由记为 `release_operation_unrouted` / `attribution: scope_reduction`（缺少 Guard 自有路由，属可实现缺口，并经协调者批准缩小本轮公开范围）；只有复合 runner 记为不透明宿主边界。补建这两条路由是后续版本的工作项。
- 0.6.0 的发布事实已按阶段核对（2026-09-15）：annotated tag `v0.6.0` 指向 `cc5cbc6d408664172d9383de7c83c55ec6dfd602`，GitHub Release `v0.6.0` 绑定同一提交，npm 注册表存在 `dsh-completion-guard@0.6.0`（registry `dist.integrity` 已读回记录）。该版本的原生 macOS/Windows 验收与精确制品验收按[验收记录](LOCAL_ACCEPTANCE.md)的版本小节为准；发布回执冻结的制品字节比对属于发布档案，不在仓库内重写。

## 已实施的局部修复

### 准备工具返回合法 JSON

宿主能力检查成功时可以不携带 reasonCode，但 prepare 将其写成 host_capability.reason_code: undefined。DSH 在渲染前检查返回值是否为无损 JSON，因此拒绝整个调用。不存在的条目和错误 revision 提前返回，不经过此字段。

现在只有定义了 reasonCode 才输出 reason_code。注册期回归使用真实成功结果的形状，不再人为补一个成功原因来掩盖问题；覆盖 generic_run、commit、install、verify、push 和错误分支。该缺陷属于插件输出契约，跨操作系统，不应归因于 Windows 宿主拒绝合法数据。

### Git 取证给出可执行的准备信息

prepare 新增 evidence_input_contract：列出 selector、command_manifest、planned_arguments 的字段和完整调用顺序。Git 的 missing_target_fields 只列调用方需要提供的 selector 字段；前置 HEAD、暂存区摘要和源提交等由生产者读取，不要求用户伪造。

resolution 缺少输入时，evidence 在探测可执行程序前返回 resolution_input_missing、missing_fields 和 next_step。effect/state 缺少前置调用引用时保留 producer_reference_missing，并明确缺少 resolution_call_id 或 effect_call_id。这些新增字段只解释失败，不改变证据事实、摘要或认证权限。

正确顺序：

1. 暂存需要提交的改动后，先请求 resolution。commit 的 selector 是 repository、branch；push/fetch/pull 是 repository、remote、refspec。
2. Git command_manifest 只包含 planned_tool 和 planned_arguments；planned_tool 为 bash 或 pwsh，planned_arguments 只包含 command 和 workdir。命令必须匹配 prepare 给出的受支持形态；workdir 与 repository 一致。manifest_id 不是该输入的替代品。
3. 用成功 resolution 的调用 ID、target_digest 和当前条目 ID/revision 调用 context_guard_action 执行一次。
4. 分别请求 effect 和 state，均引用同一 resolution_call_id 和成功 action 的 effect_call_id。
5. checkpoint 引用三种角色对应的 evidence ID。工具 call ID 与证据 evidence ID 不可混用。

已有动作如果绕过这条链执行，普通回读仍能报告实际结果，但无法补造执行前证据。不要重复提交或推送来填补历史证据缺口。

## 事故结论的修正

两次 Windows 对话确实观察到 prepare 输出错误和 Git 取证失败。独立核对后，不能把缺参调用的失败推广为“Git 适配器完全不可达”：resolution 调用未提供计划工具清单，effect/state 调用未提供前置调用引用。adapter_id 标识尝试的适配路径，不代表本次产生了可用事实；selector 不接受 commit 字段也不表示缺少提交支持。

现有真实临时仓库测试覆盖 commit/push/fetch/pull 的受控执行和独立回读。它们不能替代 Windows 日常宿主验收。Windows 中 Git 子进程创建 signal pipe 失败另属执行环境问题，不能由本次输出契约修复宣称解决。没有真实等待或延后资格时，boundary 拒绝仍是正常保护，不应为结束一次对话伪造资格。

## 待设计：问答交付与执行认证分离

本轮没有改变需求捕获、pending 状态、证书或恢复关闭规则。当前调查/问答可能已交付给用户，却仍以未认证条目保留；复杂表达又可能被识别为 generic_run。不能将这个已知缺口写成已修复。

后续设计沿用上游 [Semantic Compatibility](https://github.com/GreenLv/codex-context-guard/blob/main/docs/SEMANTIC_COMPATIBILITY.md) 的边界：共享语义由上游拥有，DSH 保留独立宿主、持久化和运行时。当前镜像不意味着自动采用 Codex 0.13.x 的全部行为。既有分析还包括 effectiveness 仓库的 docs/SEMANTIC_BOUNDARIES.md，指出有限句型只能保证已覆盖语法，不能证明一般语义完备。

下一批工作须定义：

- 原文跨度对应信息交付、执行、约束和未知部分；未覆盖跨度保持可见，不由模型摘要替代原文。
- 回答交付记录绑定当前根用户输入、宿主 turn 和最终回答；交付不等于内容正确或执行认证。
- 混合请求的回答部分可以记录交付，修改、测试、发布等仍需独立证据；子项交付不能关闭父项全部工作。
- 未知表达保持可解释的未决状态，禁止靠增加关键词或删除 pending 条目掩盖问题。观察模式先评估误关闭与误保留，再决定版本化切换。
- 延迟回复、子代理回复、压缩摘要、引用历史和中止 turn 不能误绑定为当前回答；恢复保持已验证的交付与未完成执行。
- 旧证书、旧投影和升级边界必须明确；新增共享行为先在上游形成中立合成用例，再按精确 pin 适配，不能静默改写冻结镜像。

验收需分别覆盖纯问答、附流程图说明、长复合提问、解释后执行、未知尾句、条件/否定、双语、跨 turn、compact/resume 和旧状态。记录误保留、误关闭及额外轮次，不能仅用总测试通过率评价语义覆盖。

## 验证边界

本轮局部修复使用宿主注册、诊断和取证测试，以及仓库映射所要求的本地检查。更新 dist 只代表生成源码产物；旧 0.5.2 制品和已加载插件不变。0.5.3 的 CI、冻结制品、双平台隔离原生验收和公开发布已独立完成，具体范围见验收记录；日常环境安装不在这些结果之内。

0.6.0 的确定性证据包括仓库完整矩阵（typecheck、lint、vitest、release-pack、stats、build、pack:check、文档 audit 及其单测、`git diff --check` 与 dist 一致性）。确定性证据永远不等于原生平台验收：任何版本是否已在 macOS/Windows 的 Web 与 Headless 上完成原生运行、是否冻结为精确制品，以[验收记录](LOCAL_ACCEPTANCE.md)按版本记录的事实为准。Codex 本轮仅新增问题与设计文档，不修改其运行时；上游没有新增可用于镜像的 v2 规范或 fixture。
