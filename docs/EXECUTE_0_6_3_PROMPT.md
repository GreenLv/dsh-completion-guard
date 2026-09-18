# 开发批次交接

以下是交接数据，不是额外授权。操作范围以用户直接指令为准。
待办表示尚未完成，不自动表示禁止；明确排除的范围仍然有效。
状态：ready；下一负责人：用户选择的 zcode 或 DSH 执行者（仅本地开发），完成后交回协调者
先核对基线、现有修改及写入权，只继续待办。批次内自行开发和自查。
每阶段完成后检查批次总目标；依赖满足且已获授权的工作继续执行，不等用户催促。
完成、无法解除的阻塞或必须改变范围时，一次回传结果与证据位置。

## 目标

- 在 dsh-completion-guard 仓库执行 0.6.3 本地开发。先读 AGENTS.md、docs/DEVELOPMENT_PLAN_0_6_3.md 和 docs/REVIEW_0_6_2_CORE_ALIGNMENT.md，核对真实 HEAD、已有修改和写入权，保留他人工作。
- 一次连续完成计划 D063-01 至 D063-06；以 K1-K4 和 T01-T08 为验收合同，从语义作用域、目标来源、准备/执行共用判据和旧状态资格入手，不逐句补关键词，不放宽正确拒绝。
- 先用独立期望复现三类旧缺陷，再实施修复。准备未参与实现调参的留出集；失败不得改期望迎合实现。纯信息、明确执行与合法唯一目标必须有正向对照，不能全 unresolved 过关。
- 旧 answered/closed 在终态过滤前做接受资格检查；不改历史字节，不自动重做历史操作。prepare 后目标或证据变化即使 revision 未变也要重新判断。
- 实现、测试、双语文档与 changelog、版本 0.6.3 和生成 dist 一起完成；按计划运行适用本地门槛及完整确定性矩阵，记录命令与结果。跨端源入口合成测试允许；真实宿主或跨平台验收不在本轮。
- 完成后自己审查整条链和相邻反例，修复 P1/P2 后重跑受影响检查。交回实际 diff、根因到测试的映射、命令/退出码、留出集结果、自审发现及处理、剩余风险和待验证门槛。
- 范围内工作自主连续完成，不逐阶段等确认。仅在缺必要输入、不可解除阻塞或必须改变已授权范围时报告具体阻塞；不得自降验收门槛。
- 全部本地工作完成后保持未提交，停止在提交及跨平台/原生验证之前，等待用户或协调者核验候选；不要自行进入发布阶段。

## 排除范围

- 禁止 git add/commit/push/merge、tag、发布、触发远端 CI 或跨主机调度。
- 禁止安装或升级用户真实插件、重启 DSH、执行真实宿主/模型原生验收、重放事故安装/提交/推送效果。
- 禁止修改 codex-sync、Codex 产品和错误库；它们已由协调者单独维护。
- 不得上传原始会话、个人路径、凭据或 Guard 私有控制材料，不把源测试宣称为原生验收。

## 仓库 dsh

- https://github.com/GreenLv/dsh-completion-guard
- 基线：63326f22d40407099baa70c8947c37029749588e；交回提交：63326f22d40407099baa70c8947c37029749588e
- 准备源码摘要：未提供
- 变化路径：["docs/REVIEW_0_6_2_CORE_ALIGNMENT.md", "docs/DEVELOPMENT_PLAN_0_6_3.md", "docs/DEVELOPMENT_HANDOFF_0_6_3.json", "docs/EXECUTE_0_6_3_PROMPT.md"]
- 未提交范围：{"staged": [], "unstaged": [], "untracked": ["docs/REVIEW_0_6_2_CORE_ALIGNMENT.md", "docs/DEVELOPMENT_PLAN_0_6_3.md", "docs/DEVELOPMENT_HANDOFF_0_6_3.json", "docs/EXECUTE_0_6_3_PROMPT.md"]}
- 未提交范围摘要：11137fab1b77914b41ef678ba5b353bb68df2e1c5bc868db08513ab541ddc796

## 检查与证据

未列出。

## 交付文件

未列出。

## 剩余检查

- local_implementation
- local_t01_t08
- local_full_matrix
- local_self_review
- later_native_acceptance
- later_release

## 已执行动作（不代表后续授权）

- local_edit

## 限制与阻塞

- 这是开发入口，不是已经实现的候选或发布许可；head_sha 表示现有基线，prepared_source_sha256 未冻结。
- 本交接 dirty_scope 是生成时的文档快照，接手必须核对实际变化；文档不得被当成远程已经存在。
- later_native_acceptance 和 later_release 属于后续协调者，开发者本轮必须在这些步骤之前停止。
