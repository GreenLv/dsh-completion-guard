# 0.6.3 合同修订说明（收窄自动授权范围）

状态：**用户明确批准的验收合同调整**，不是对旧合同的“全部实现”声明。本文列出被替代的验收条目、
代价、替代它们的结构性不变量，以及仍然有效的条目。历史材料
（[开发计划](DEVELOPMENT_PLAN_0_6_3.md)、[0.6.2 复核](REVIEW_0_6_2_CORE_ALIGNMENT.md)、
[执行提示](EXECUTE_0_6_3_PROMPT.md)、历轮[验收记录](LOCAL_ACCEPTANCE.md)）保持原样，不静默改写；
本文只记录它们之上的一次显式变更。

## 1. 为什么修订

上一版 0.6.3 合同要求：调查/解释/疑问头治理其句子，**同时**“同句调查之后的第二条指令必须自动授权”。
满足该要求只能靠“补语是否闭合”的猜测规则（状态词命中、主体词表未命中、工作动词命中、位置与长度窗口）。
十四轮独立复核逐条证明这些推断在开放类别上不可靠：状态词可以是动作的宾语或修饰语，主体可以出现在任何
位置，动作词可以完全不在词表内。每一次修补都只是把猜测换成另一条猜测。

本次修订把要求收窄为**可证明**的形态：不能证明“该动作是独立指令”时，保留未决义务并拒绝执行授权。

## 2. 被替代的验收条目（原文保留在 LOCAL_ACCEPTANCE 的历轮记录中）

| 被替代的条目 | 现在的合同 |
| --- | --- |
| `Check whether an update exists and install the package.` 的第二动作必须授权 | 允许保守进入**未决**；不再要求自动授权 |
| `检查是否有新版本并且安装这个主题。` 的第二动作必须授权 | 同上 |
| `检查是否有更新并安装新主题。`、`检查服务是否正常并记录变更。`、`确认缓存是否有效并安装依赖。`、`Check whether the cache is valid and install the package.`、`Verify whether the lock file is current and install the package.`、`有没有最新版本并…` 等“已证明是状态疑问”的正例必须保留其并列指令 | 同一治理范围内的并列动作一律**未决**；不再按“状态疑问”区分 |
| `解释头治理的句子在其补语已闭合时，并列小句开启新谓语，其指令照常保留`（`说明…的作用，然后更新 README。`） | 解释头治理**整句**，句中并列一律未决；只有**另起一句**的指令仍可授权 |
| 句末问号/标点/拆分可以把先前的指令保留下來（`What changed, and update the README?` 的 README 更新） | 同句疑问与动作混排即未决；标点本身不构成授权 |
| “命令式调查的补语若能证明是状态疑问则闭合” | 该闭合规则**整体删除**，不再保留第二条授权路径 |

**代价**（明确接受）：在同一子句内把“问一句 + 顺手安排一件事”的写法视为未决，用户需要**另写一句**
明确指令才能授权；无法命名的状态与被证实为动作的内容都不再获得自动授权。安全方向优先。

## 3. 仍然有效、且被本次修订加强的条目

1. 纯问答仍可回答（`检查是否有新版本。`、`Is there any update for the plugin?`、对象列表疑问）。
2. 普通明确指令仍可执行（`重启 api 服务。`）。
3. **明确脱离受限范围的独立指令**仍可授权：另起一句（`Explain how the team deploys. Then restart service api.`）
   或另起一个分句（`检查是否存在更新；安装新主题；`）。
4. 未决义务**必须保留**：不产生 `items = []`，不能被普通回答关闭，不能取得完成证书。
5. 引号、代码、转述等父范围继续保留：受限范围内的动作永不是授权。
6. K2 目标身份、K3 prepare/execute 一致性、K4 旧记录资格与历史保真继续有效；旧记录**不再默认获得**新授权。

## 4. 替代机制：资格（qualification）

- 读取层在**任何分区之前**为每个子句建立一次 `ExecutionQualification`：
  `granted` 或 `restricted`。**`granted` 是正面结论，不是默认值**：只有在子句自身范围既无疑问内容
  （疑问词、是非标记、`?`/`？`、A-不-A 等），又确实命名了读取层能识别的动作时才成立；
  其余一切（未分类的疑问内容 `I wonder whether …`、后置 `是否可行`、无法识别的动作形态）一律
  `restricted`（`unproven_scope`），因此“未命中治理模式即授予”不成立。
- **指令的正面判据是"祈使"，不是"提到了动作"**：`The technicians restart service api every
  night.` 与 `日志显示运维人员重启 api 服务。` 只是陈述，不构成指令；`granted` 现在要求子句是
  **root 自己语气的祈使句**（`opensWithDirective`：消费请求前缀后动作位于句首，或句首是闭类的
  施事/处所/时间/对象短语 `由你…`、`在仓库…`、`按 P0—P4…`、`明天…`），并排除报告体。
  仅"命名了动作"不再授予资格。由此 `restricted` 与 disposition 被强制一致：受限子句不会再出现
  `executable_now`，而是 `unresolved`。
- **父范围先于切分成立**：引号（`"…"`、`“…”`、词边界处的 `'…'`、`「…」`、`『…』`）与代码跨度
  拥有自己的标点，引号内的句号/问号不再切开外层子句；受保护子句在连接符处不可再分。
  `Explain this instruction: "Install foo. Restart service api."` 与
  `解释这条指令：「安装 foo。重启 api 服务。」` 因此都是**一条**受限义务。等待/恢复标记
  （`waitAuthorization`、resume marker）同样只读 root 自己的话，引号内的回声不再构成保留。
- **显式重述按"重述内容 + 身份绑定"授权**：重述先取出被重述的跨度（`restatedContentOf`），
  再让它通过**与普通子句相同的判据**（`qualificationOfClause`：无疑问内容、祈使句首、非描述谓语），
  或确认它是**规范操作规格**（`restatedContentIsOperation`：句首是操作，或首词/首二字解析为操作）。
  仅"文中出现动作"不成立：`把重启 api 服务记为需要讨论的重启操作。`、
  `把重启 api 服务明确为解释重启流程。`、
  `Record restart service api as a description of how technicians restart service api.`
  一律 `restricted`。同时**资格绑定到重述后的动作与目标**：捕获时 `semanticAction` 与
  `actionPlan` 取自被重述的跨度，因此 `把重启 api 服务明确为检查日志。` 即便被授予，其身份是
  "检查日志"而不是重启——重述之前的动作永远不会因此获得授权。合法用法
  （`把更新插件明确为 apply package demo@2.0.0 profile web`、`把应用包 … 明确为 apply`、
  `…明确为 inspect_remote_updates`）仍是 sanctioned 的 `granted` 路径，也是无法识别的动作形态
  获得授权的唯一文本路径（裸写 `应用包 foo …` 不再授予资格）。
- **句首是动作仍不等于祈使**：`重启 api 服务是一个危险操作。`、`Restart service api is
  dangerous.` 的主语就是那个动作，属描述句。`opensWithDirective` 因此要求动作所在子句的
  **谓语不是描述性的**（`是/属于/意味着/导致…`、`is/are/means/causes…`，且只看动作所在的那个
  子句，相对从句与后续子句不参与判定）。
- 由此产生的**代价**：动作词表之外的祈使形态（例如 `打包日志以便确认哪些请求失败。` 的“打包”）
  也被判为 `restricted` —— 拒绝授权而不是猜测。该边界是安全方向，且只有正面证据能改变它。
- 分区、投影、恢复、prepare 都**不能**新增执行权限：子项继承父范围的资格（`inherited_restriction`），
  不会因为自己带动作头而被提升为 `executable_now`。
- 变更门禁与 prepare 消费**同一份**存储资格（`itemHoldsExecutionAuthority`），并对 `semanticAction`
  与 `actionPlan` 中的**每一个**动作适用；二者都不再重新分析文本。
- 资格缺失（0.6.3 之前的记录）→ 拒绝授权，并由升级资格检查给出
  `legacy_missing_execution_qualification`，历史状态/文本/`answeredBy` 一律不改写。

数据流（可在测试中直接读出）：
`interpretMessage().qualification` → `captureClause().executionQualification` →
投影/恢复持久化 → `itemHoldsExecutionAuthority()` → 门禁 / prepare。

- **新旧跨度各自验证唯一性，再逐字段合并**：同一跨度出现两个候选即记为
  `requested_target_field_ambiguous` 并要求澄清（`把重启 api 服务或 worker 服务明确为 restart。`、
  `把重启 api 服务明确为重启 worker 服务或 cache 服务。`）；新跨度显式给出的字段优先，**省略的每个
  字段**在被澄清义务唯一时继承（`把应用包 foo 版本 0.6.3 配置档 default 明确为 apply package foo
  version 0.6.4。` 保留 `profile=default` 并采用新 `version`），旧选择有歧义则不继承并拒绝；主动作与
  `actionPlan` 共用同一规则。

- **候选枚举与目标提取共用同一语法与规范化**：候选集合由提取器自己的解析器（label-first、
  动词-宾语、名词后缀三种形态）枚举，每种形态内部独立判歧义，因此
  `Rebind restart service api or worker as restart.` 与
  `Rebind restart service api as restart service worker or cache.` 的共享标签列表不会再漏检；
  `actionPlan` 的每个条目同样调用该检查（`restatedSpanAmbiguous`），主动作与计划共用一条规则。

- **唯一性覆盖动作的完整身份字段**：枚举按动作的身份字段合同逐字段进行——service、package、
  version、profile、registry、repository、branch、remote、refspec——而不是只看对象名；
  `version 0.6.4 or 0.6.5`、`profile web or prod` 因此与 `service api or worker` 一样被判为歧义。
  重述路径读"被澄清跨度"而非整句（整句必然同时含新旧值，会被自身误判为歧义）。边界：该审计应用于
  需要调和两个跨度的**重述**合并；普通子句沿用既有提取器的单一读数（既有 fixture 族不变）。

- **唯一性审计覆盖普通捕获、重述与动作计划**：普通分支此前直接采用单值提取结果，现已与重述共用
  同一结果（`restatedSpanAmbiguous` 按动作的完整身份字段合同枚举），动作计划的每个条目同样消费它。
  `Restart service api or worker.` 与 `提交仓库 /repo-a 分支 main 或 release。` 因此都是
  `requested_target_field_ambiguous` + `clarification_required`。为使普通入口可用，枚举与提取
  统一使用同一套**带边界的标签/动词定义**（`IDENTITY_LABELS`）：标签值必须与标签分隔（避免把
  `/repo-a`、`synthetic-plugin`、`repo/sub` 里的片段读成第二个候选），拉丁语标签/动词不被路径或
  复合词中的字符吞并，中文标签仍可在 `把/将` 之后直接出现。

- **候选值按各字段的身份规则规范化，不做统一小写**：标签可以大小写不敏感，但分支、refspec、
  repository、remote 等 Git 身份值区分大小写（`main 或 Main`、`main:main or main:Main` 都是两个
  候选 → 歧义拒绝），package 走包名解析、registry 走规范形式；**完全相同的值仍然只算一个候选**
  （`main 或 main` 通过）。

- **包规格是完整字段元组**：`foo@1.0.0` 与 `foo@2.0.0` 是两个目标（同名不同版本），
  `foo@1.0.0 version 2.0.0` 是同一字段的冲突——两者的版本候选合并且逐字段验证；完全相同的重复值
  仍只算一个候选。**审计与提取共用全部字段标签**：中文 `引用规范` 等标签同样纳入枚举（此前只在
  提取器里存在）。

## 5. 与上游的关系

上游 Codex Context Guard 仍按自己的判据运行：本次修订只改 DSH 一侧的授权范围，
跨端台账 `tests/fixtures/cross-end/core_alignment_0_6_3.json` 以修订 4 记录该变化
（`mixed-conjunction-zh` 从“1 信息 + 1 指令”变为“1 未决”），两端**仍然都不授权**该安装，
但机制与信息量不同；不得据此推断任何跨端等价或原生能力。

## 6. 未测量的能力（不因本次修订改变）

原生宿主恢复与 Codex 宿主轮次、候选 CI、冻结 tgz 与精确制品验收、macOS/Windows 原生验收、
真实模型行为、插件安装与 DSH 重启、tag 与发布，均仍未测量。本修订与这些事实无关。
