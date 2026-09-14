# 下个版本：准备工具、Git 取证与问答残留

状态：局部修复已随 0.5.3 发布（2026-09-14），后续语义设计仍待补充。本页以 0.5.2 为事故修复基线；精确制品与平台结果见[验收记录](LOCAL_ACCEPTANCE.md#053-published-release-2026-09-14)。

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

本轮局部修复使用宿主注册、诊断和取证测试，以及仓库映射所要求的本地检查。更新 dist 只代表生成源码产物；旧 0.5.2 制品和已加载插件不变。0.5.3 的 CI、冻结制品、双平台隔离原生验收和公开发布已独立完成，具体范围见验收记录；日常环境安装不在这些结果之内。Codex 本轮仅新增问题与设计文档，不修改其运行时。
