# 0.6.2：普通任务能力诊断与部分失败的事实边界

日期：2026-09-16。状态：D062-01–03 已实施并经本地复核；D062-04 的有界函数级对照已补齐（不等于原生验收）；进入发版准备，尚未冻结候选或发布。后续门槛见 [0.6.2 发版计划](RELEASE_PLAN_0_6_2.md)。

## 结论

本次不能归为单一 Windows 插件故障。Windows 原生文件系统报告目录被另一进程占用；执行代理在尚未证明“无依赖”的条件下清空工作树、反复尝试删除，随后过度描述“无功能影响”；DSH Guard 则把明确但没有专用认证适配器的清理任务表示为 generic_run，并给出不适用的用户补输入/rebind 建议。三者必须分开修复和计量。

目标为 **0.6.2**：纠正既有普通任务责任边界、能力诊断、结果表达和验收覆盖；不通过新增通用删除执行器或自动认证任意 shell 来扩大产品能力。不重做 0.6.1 已通过的附件/分页修复，也不将所有 pending 清空作为成功标准。

## 基线与证据

DSH 本地干净 main 为 `d11009d8f755ecee7d288cff18250c7b372cfd2a`，package 0.6.1。Windows 导出的仓库 HEAD 与之相同；这只证明被操作仓库身份，不单独证明已加载插件字节。日志包含一次根任务、19 次工具调用、两次成功 prepare，无 Guard 异常抛出、无 checkpoint 认证调用，也没有 Guard 阻止删除的证据。

原始日志、会话身份、路径和私有回放保留在仓库外。以下为脱敏归纳，不将附件里的清理请求当成本次授权，不继续删除 Windows 文件或运行原始脚本。

| ID | 观察与源代码定位 | 判定 |
| --- | --- | --- |
| W061-01 | discovery 已有 total/listed/has_more，单项清理为 generic_run；`diagnostics.ts` generic 分支仍是 user_input_required，映射到 source_insufficient，建议改成受支持动作并确认。`checkpoint.ts` 明确拒绝 generic 认证。 | 认证能力有限本身不是故障；把能力缺口归给用户且推荐不能保持原义的 rebind 是诊断缺陷。跨平台。 |
| W061-02 | 多个 worktree remove 同处一个 pwsh 脚本，中间一项退出 255，后续命令继续。宿主 tool/result isError=false，无终止非零 marker。给回放显式提供仓库审计的 Windows rc.2 host-lock fixture 后，`evidence.ts` 得到 outcome=success、parseStatus=unsupported_statement_operator。 | success 在此是宿主工具调用返回且未标错误的旧分类，没有独立结构化退出码，不证明每个删除成功；现有 parse/generic 拒绝保留，不能称 Guard 错签成功证书。诊断/展示必须明确两层事实。 |
| W061-03 | 删除前检查了 clean/HEAD/无 Git lock，未充分排查 task/process cwd 与运行时依赖；删除后才搜索进程命令行，随后反复 Remove-Item/rename，出现被另一进程占用错误。最后目录仍存在但为空、Git 注册已移除。 | 原生占用是环境事实，依赖检查不足及恢复次序属于执行流程缺陷。命令行不含路径不证明无 cwd/handle，具体持有者和“pending delete”精确状态未被证明。 |
| W061-04 | 最终同时说清理完成、无功能影响，又承认可能有任务仍依赖已清空目录。分支提交仍可按 SHA 读取被描述为可回滚。 | 部分完成与依赖未知不应表达为全部满足“无依赖”；悬空对象当前可读不是持久备份或无限期恢复保证。属于结果报告/证据边界问题。 |

0.6.1 的首次 guidance 已将 Guard 执行链改成有条件使用，不再无条件审批普通工具；本次不把旧版本的 guidance 缺陷重复登记。没有充分证据认定日志泄露了私有控制令牌；最后那段泛化的认证说明仅属无关实现细节，不应夸大成敏感信息泄漏。

## 为什么 Codex 通常不出现同样提示

比较对象是实际安装的 Codex Context Guard 0.13.9，不从 Skill 文案推断实现。读取其 `scripts/context_guard.py`：

- `verification_contract` 对两条中英文合成的普通分支/工作树清理请求返回 legacy_fallback/no_deterministic_contract，不生成确定性义务。这是函数级探针，不是完整原生任务验收，也不能推广为所有清理表达都会落在同一分支。
- `derive_ordinary_proofs` 只自动推导其支持且唯一绑定的 artifact readback / scope coverage；`_auto_complete_checkpoint` 不把任意成功工具提升成完成。
- `handle_stop` 在无确定性未完成义务、无其他续跑门槛且无法唯一认证时，可以静默结束，保留 completion_claim_uncertified_pending_items。故“没看到报错”可能只是静默未认证；若存在强制证明、完整性失败或当前可执行工作，仍可能纠正。
- DSH 的 `decideTurnBoundary` 普通情形同样可 safe-yield/preserve pending；此次可见错误码来自模型主动调用 prepare 并在最终答复中复述，而非 Stop 强制中断。

因此二者不是“一个成功认证，一个认证失败”的对照实验；它们的可见诊断入口、义务推导和认证模型不同。DSH 的有限 semanticAction + action producer/三角色模型与 Codex 的 obligation/proof 模型尚未完全对齐。共享 digest/v1 fixtures 不证明全功能等价：本仓库 UPSTREAM_PIN 仍绑定 `b59fcfe1aaf8ead3f0438bc67dc7f725c869a473`，Semantic Compatibility 也明确否认完全功能对等。

Windows 占用错误换成 Codex 在同一目录执行也可能遇到；没有证据表明 Codex 能绕过它。两个执行代理是否事先保护活跃工作树，取决于执行流程和可观察宿主事实，不由使用哪个 Guard 自动保证。不能为了对齐让 DSH 隐藏真实业务失败，也不能让 Codex 的静默结束被当成成功证明。

## 开发工作包

### D062-01：能力、输入与修复建议统一

在共享能力投影中区分：解释未知、目标/参数真正缺失、明确动作但没有认证适配器、历史前态缺失、部分/不可归属执行、已验证完成。不要仅以 generic_run 一个枚举推断根因，也不要只针对“清理”增加词表。

对没有保持原义的可达认证路径，repairability 应是 unsupported（或兼容的能力不可用表达），不能要求用户改说 install/modify。建议应为继续已授权普通工作、保留可观察结果、不得宣称证书；有真实歧义或目标选择才请求补充输入。rebind 仅用于能保持原范围且有真实状态转换的澄清，不将产品适配器缺口转成用户授权缺口。

统一 prepare/recovery/status/checkpoint 的 reason 与指引。默认回复不要求代理向用户复述认证内部术语；业务失败、未完成范围和用户需要的操作仍必须清楚报告。只有用户询问 Guard 状态或明确要求证书时才展开认证能力说明。

### D062-02：shell 完成与业务结果分层

保留宿主终止契约：宿主工具返回、明确的进程退出码与可归属单操作成功分开；未能解析的复合 runner 的操作层为 unknown，不从 output 中任意 error/exit 文本猜测业务事实，更不因最后命令成功覆盖中间失败。

只读派生诊断可以新增明确的 process outcome / operation attribution / applicable evidence 字段；无明确退出码事实时新的 process exit status 保持 unknown，不把旧 outcome=success 改称已经读取到 exit 0；不能静默更改旧 evidence.outcome、旧摘要域或重解释已冻结历史证书。所有认证消费者继续校验 parseStatus、目标、来源与所需事实，不能单独消费 success。若持久化新字段会改变语义，先分配版本和迁移边界。

有可信结构化逐操作结果时才表达 partial_failure 及确切子集；只有不透明 shell 输出时给出 unknown 和只读复核建议。当前事故中 Windows 报错是人可读观察证据，不等于插件已获得标准逐操作生产者。不得通过 stderr 关键词白名单自动认证或回溯构造前态。

### D062-03：保留限定条件与安全失败恢复

将“无用/无依赖”保留为清理结果的适用约束，而不是从 clean 或 ancestor 推断完成。为维护流程增加清理前后清单：Git 独有内容、dirty/untracked/ignored、任务 cwd、进程/句柄、运行时链接、外部消费者和恢复依据；这些由执行者与宿主适配层负责，不增加普通工具审批 gate。

对候选逐项记录 dependency_free / in_use / unknown：unknown 不参与要求“无依赖”的自动删除集合；报告保留原因即可，不反复让用户重述原授权。Windows 没有可靠 cwd/handle 读取能力时明确未知，不能用命令行搜索替代。发生部分删除后先只读核对目录内容、Git 元数据及受影响任务；不可自动强删、杀进程、重启或在占用目录里反复写入探针。

将 metadata_removed、content_removed、directory_removed、dependency_status 分开报告。只列 git worktree list 为空不证明目录消失或任务无影响。保留分支若只是悬空 SHA，明确恢复期限未知；需要持久归档时使用已有授权范围内的稳定引用/备份并验证，不能把可读对象当备份。

本版本用合成场景、恢复说明和现有证据/约束接口约束这些行为，不构建万能 Git 清理执行器。对宿主不可观察条件保持未认证，不能承诺插件自动阻止所有危险清理。

### D062-04：与 Codex 做结果合同对照

将同一合成任务和等价事实分别送入两端真实入口，比较 obligation/coverage、operation attribution、completion、pending、wait 和用户可见纠正；保留各宿主事件编码差异。期望对齐的是来源、事实强度及不伪造完成，不是 reason_code 字符串或“都不报错”。

Codex 原 C04/C06/C08/C09/C12 已覆盖大部分原则，只补跨端静默未认证/显式能力诊断的对照 oracle，以及混合结果与无依赖限定条件；不把 DSH 事故登记成 Codex 已发生同类 native bug。上游共享 fixture 未落地前，DSH 用版本明确的本地回归，不覆盖旧 pin、不宣称 parity 完成。

## 验收与阶段出口

| 测试组 | 必须证明 |
| --- | --- |
| T01 能力诊断 | 中英同义清理、归档/重命名等未知动作与真缺参数分开；无适配器不要求用户改成另一动作；不虚构 authorized/answered/certified。 |
| T02 输出层次 | 单命令成功/失败、非零被 catch、循环中间失败后成功、输出含示例 error、宿主超时/中断、只有最后退出码；不透明复合操作保持 unknown，不签发证书。 |
| T03 条件和子集 | 干净但活跃、ignored 文件、外部链接、未知占用者、部分注销/部分删除；只完成已证明适用子集，不将“无依赖”从闭包删除。 |
| T04 普通结束 | 默认普通任务不被新增审批链阻断；保留 pending 可静默结束；显式强制证明仍拒绝缺证；用户主动诊断时说明能力限制，失败不能被静默掩盖。 |
| T05 迁移/回放 | 0.6.1 旧证据和证书不被重新认证，新增诊断不变旧 hash；相同输入重放结果稳定。 |
| T06 原生 | Windows 隔离目录真实持有句柄并产生部分删除，核对实际状态；macOS 用各自原生行为，不能要求同一错误码；均禁止碰用户活跃任务。共享合成回放不算 native 通过。 |

先最小反例和 owning tests，再按改变的语义/consumer 扩展。候选冻结才跑完整本地矩阵、CI 和同一 tgz 跨主机验收；未提交工作树不产生正式冻结制品。计划实施后自审来源、能力、部分失败、约束遗漏和兼容性，交付未提交候选；提交、跨主机验收、安装/重启及发布另按用户后续指令执行。

当前四条本地断言只复现 generic/diagnosis 及宿主输出层次，Windows 平台上下文来自明确注入的审计 fixture，不能证明现场 host-lock 已加载。首次缺平台的回放为 unknown；修正测试上下文后观察到旧工具级 outcome=success，但 parse 仍 unsupported。没有以调宽 host-lock 或降低 parse gate 获得认证。
