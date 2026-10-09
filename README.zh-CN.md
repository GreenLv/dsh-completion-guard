# dsh-completion-guard

[English](README.md)

DSH Completion Guard 是 DeepSeek Harness 插件，负责保存任务要求，并在认证完成前核对已保存的结果。长任务或恢复后的会话中，它帮助助手继续核对文件修改、测试、禁止事项和你后来补充的要求。

**首次打开或恢复已有历史的会话，需要等待载入。** DSH 载入历史，Guard 重建会话状态，界面可能显示“载入历史”；请等加载结束再继续。`always` 让新建根会话从首条真实输入开始受到保护，不会让历史载入立即完成；再次打开也不能保证没有等待。

![核对任务要求及对应证据后，再认证完成](assets/social/completion-guard-hero.png)

## 安装或升级

需要 DSH `>=0.2.0-rc.2`、Cordis `>=4.0.4`、Node.js `>=22` 和 pnpm `>=11`。Web、Headless 和官方 Desktop 应用使用各自的配置目录。已审查的宿主基线是 DSH `0.2.0-rc.2` / Cordis `4.0.4`，更新版本仍须通过兼容性核验。

先选好路径，再替换任何包：

1. **首次安装，没有旧 Guard 会话：**停止宿主，在使用的 profile 中安装 Guard，核验并绑定本次安装后再启动。
2. **已有旧会话，需要升级：**先停止相关写者，保留旧安装包及其有效模式来源。**升级前**冻结会话库存并准备迁移收据。安装后重建宿主锁，保持写者停止，完成旧模式的 `adopt` 和 `verify`；目标范围核验通过前不能启动升级后的宿主。无法核实的旧模式保持待处理。

Web 在完成相应准备后安装：

```sh
dsh plugin --profile web add dsh-completion-guard@0.9.0
```

装好插件还需核验环境。**宿主锁**记录这个 profile 实际加载的包和目录：先用 `inspect` 检查，再用 `inject` 写入，最后以 `verify-dump` 核对组合配置；注入前备份 `cordis.patch.yml`。[安装与首次载入](docs/GETTING_STARTED.md)给出 Web 命令、Windows 和 Desktop 路径及启动前的最后核验。[旧会话迁移指南](docs/ACTIVATION_MIGRATION.md)提供升级准备、完整命令和可复制的 AI 提示词。

## 启动后会看到什么

已有会话请先等历史载入和状态重建结束，再查看：

```text
/context-guard status
```

**使用默认配置的新建空根会话**采用 `always`，显示 `armed`，表示 Guard 已就绪、等待你的首条真实消息。此前 Guard 不追加会话事件，你仍可选择 DSH 会话 preset；DSH 可能记录自身的初始化事件。首条真实输入进入执行步骤时，保护就在同一步骤内开始，覆盖任务的第一次文件修改。图片或附件也能启动保护，纯空白消息不会。显式配置的 `activation: opt-in` 继续有效，需要执行 `/context-guard on` 才开始保护。

**旧会话**保留已核验的升级前模式，旧空会话也一样。新默认值不会覆盖旧绑定。显式 `activation` 与绑定矛盾时会报告 `activation_mode_conflict`；要采用新默认值并保留旧模式，请按[配置步骤](docs/GETTING_STARTED.md#新会话默认模式)操作。绑定缺失、损坏或冲突时，Guard 报告原因并拒绝认证，不猜测身份或模式。分叉会话继承父会话绑定的初始模式。

照常让 DSH 改文件、跑测试即可。DSH 执行工具，Guard 保存要求，并核对已记录的结果和必要的回读。例如，“修改配置并让测试通过”需要修改后的文件证据和通过的测试结果，助手说“已完成”还不够。`context_guard_prepare` 说明缺什么证据，`context_guard_checkpoint` 检查能否认证完成。

默认策略仍是 `standard`。自动参与保护不会增加修改、执行或发布权限，也不会自动签发完成证书。

## 模式和常用命令

| 命令或模式 | 作用 |
| --- | --- |
| `always` | 新建根会话从首条真实输入开始自动保护。 |
| `opt-in` | 在会话中执行 `/context-guard on` 后开始保护。 |
| `/context-guard status` | 查看启用状态、未完成检查及其原因。 |
| `/context-guard off` / `on` | 关闭或开启当前会话的保护，保留历史。 |
| `/context-guard diagnose` | 解释完成检查的结论。 |
| `/context-guard clear` | 撤下当前检查表，保留禁止项；不表示其中的工作已执行完成。 |
| `/context-guard migration` | 查看会话适用规则及升级、回退的影响。 |
| `/context-guard release` | 查看显式采用的发布合同及剩余工作。 |

Guard 启用模式与 DSH 的标准、极简或自定义会话 preset 分开。已保存的 `off`、`on` 继续有效。如需修改后续新根会话的初始默认值，按[配置步骤](docs/GETTING_STARTED.md#新会话默认模式)操作，保留已有宿主锁字段和旧会话绑定。

## 历史载入与 0.9.0 缓存

首次打开或恢复已有会话时，需要载入历史并重建 Guard 状态；再次进入也可能等待。这与新空会话的 `armed` 不同，后者是在等待你输入。

0.9.0 只在确认历史未变、检查结果可安全复用时，复用旧历史已经通过的检查。同一次 Desktop 安装检查中，也会复用已读取并核验的应用文件。每次操作仍核对当前模式，并按需要重新核验 Goal 状态、私有记录和宿主环境。**本版没有修改官方宿主的历史视图生命周期或解码缓存，不能保证消除所有界面载入等待。**详见[本版性能边界](CHANGELOG.zh-CN.md#090)和[验收记录](docs/LOCAL_ACCEPTANCE.md)。

官方读取器若拒绝旧格式，先保留原日志和旧模式来源。可以用 `inventory`、`select` 明确选择可读会话，并在 `inspect/adopt/verify` 三步使用同一 `--selection`。排除的会话继续待处理：`selected_complete` 只表示选中行完成，不等于整库完成。损坏、权限问题及其他异常不会自动跳过。[迁移指南](docs/ACTIVATION_MIGRATION.md)提供命令、恢复方案及 AI 提示词。

## 限制与隐私

Guard 保存要求、核对相符的已持久化结果，并在恢复时重新检查。证据不足或状态损坏时，它拒绝认证完成。它能守卫自身接入的 Goal 完成路径，不能控制 DSH 所有内部写入，也不替代 DSH 的权限、工具、Goal 或压缩机制。普通调查可以如实回答，并不总能获得机器完成证书。

Guard 保存有界、脱敏的证据摘要，不保存完整提示词、stdout、文件、凭据、图片或原始会话正文，详见[隐私说明](docs/PRIVACY.md)。磁盘安装不证明运行进程或界面已经加载；Guard 的市场重启适配器仍不可用。[兼容性说明](docs/COMPATIBILITY.md)列出可认证命令和平台边界。

<details>
<summary>高级完成检查、恢复行为与上游关系</summary>


启用后，Guard 会保存用户直接给出的要求和验收条件。只有已保存的工具结果与指定命令、文件或其他目标一致时，才能作为证据。取得机器完成认证需要通过 Guard 检查；证据缺失、过期或对象不一致时，任务保持未认证。当前证据规则未覆盖的调查或解释仍可如实回答并结束，但不会取得完成证书。

只读观察与修改包、文件、服务或 Git 状态的操作保持分离。普通动作由宿主工具执行；查询成功不会自动产生变更权限。精确命令限制和平台证据见 [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md)。

### 要求一直未完成时

“更新插件并检查 GUI”可能包含 Guard 尚不能认证的部分；而“是否有更新”这类提问属于调查：Guard 会保留原文和来源，但如实说明无法机器认证——完成调查并如实回答即可。checkpoint 会逐项给出原因和一个具体的下一步。`context_guard_prepare` 用于诊断要求和缺失证据，不是普通宿主工作的执行配方。

只有根要求本身需要拆分时，才用 `context_guard_rebind` 提出完整的原文拆分方案。普通工作缺少认证支持，不构成重新绑定的理由。动作或对象不明确时，先请根用户给出包含原条款的明确澄清要求，再在提案中引用新要求的 ID。工具会返回提案 ID 和原项/替代项对照；用户把确认行 `确认重绑定 <proposal ID>` 作为回复的第一行即可应用，空行之后的解释请求或新任务保留各自含义，新任务照常采集。嵌在句子、引号或代码块里的确认，以及后面跟反转表述的确认，都无效。把要求拆成同样不可认证的片段会得到“无认证收益”，而不是要求一次无意义的确认。未支持的部分继续保留 pending；按结构化边界安全结束也不表示全部完成。

用 `bindings: []` 调用 `context_guard_checkpoint` 可查询诊断。默认最多展示八个当前要求/限制和十条证据，插件 JSON 不超过 12 KiB。`pagination` 给出总数及各列表独立的 `next_cursor`，首页不代表完整合同。`item_ids`、`evidence_ids` 可按 ID 查询；`evidence_scope: "history"` 可查看完整证据历史，其中不可引用项会明确标记。翻页时保持查询条件不变，合同或证据快照变化后需重新查询。超长行提供 `detail_id`，用 `detail_offset` 取分片；后续分片需把首次返回的 `snapshot` 作为 `detail_snapshot` 传回。分页只改变展示，不会减少认证时检查的要求。

## 完成与恢复

Guard 按原始范围保留每项要求、禁止项和答复义务。宿主记录答复已交付后，问题才可关闭；文件修改、测试或回读仍需各自的真实结果。修改图片的要求要核验修改后的图片，不能只看工具是否成功。显式 proof 要求继续走 proof 契约；已采用的 Goal 完成路径仍核验必需结果。

动作来源决定其范围。未来观察、尚未满足的时间或审批条件、证据不足和已就绪的具体动作是不同状态。后来的授权不会改写更早的 Stop 判断。有来源的暂停、取消或简短恢复只影响其范围内已经存在的工作；引用文字和旧 generic 待办不会在重载后变成当前授权。旧 v5 历史保留供复核，新 v6 工作使用当前合同。

义务含糊时，`context_guard_rebind` 可以提出精确拆分，但只有根用户明确确认才会应用。无法支持的核验会如实报告证据不足，不授予动作，也不强迫再次编辑。用 `/context-guard diagnose` 和只读 checkpoint 查看缺失谓词，再通过宿主工具完成可支持的工作，并如实说明边界。

旧安装的 0.6.3 执行流程保留在[对应更新日志](CHANGELOG.zh-CN.md#0632026-09-18)中。当前普通 `context_guard_action` 与 `context_guard_evidence` 调用只返回迁移说明。

## 策略档位

三个档位决定完成时需要多少证明。它们与 `opt-in` / `always` 激活方式相互独立，安装也绝不进入 release 档。

| 档位 | 要求 |
| --- | --- |
| `standard`（默认） | 工作必须有持久证据支撑；普通工具不会被额外的 Guard 审批拦在后面。 |
| `strict` | 在 standard 之上，你明确要求的视觉或完整范围验证必须由真实回读事实兑现，而不是一次"只是成功"的工具调用。 |
| `release` | 显式采用的发布契约按精确候选和一次性预约核验受覆盖的发布操作。契约本身不提供用户授权或宿主权限。 |

若要使用 `strict`，先备份 `cordis.patch.yml`，再仅修改或添加原 `context-guard` 条目 `config` 下的 `policy`。保留启用模式、注入的宿主锁字段和其他配置。下方只展示要改的字段，不能替换完整条目：

```yaml
policy: strict
```

### 显式发布契约

消息中的“发布”关键词、加载的 Skill 或安装都不会自动采用发布契约。用户另外授权发布后，可通过 `/context-guard release adopt` 显式给出所覆盖的操作、候选 ref、完整提交、版本和制品摘要。`/context-guard release` 随后显示覆盖范围与未结算操作。新版本不能复用历史候选身份。

采用之后，`/context-guard release` 报告契约、候选、逐操作覆盖范围、已消费内容和仍在执行中的操作。每个操作只消耗一次预约记录：效果前写入，效果后依据可信回读结算。错候选 SHA、错 ref、错制品摘要或版本、过期票据、已消费票据、仍在执行中的请求重试和不透明 runner 都会在任何副作用之前被拒绝。

保留的受控 npm 发布路径与已退役的普通 action/evidence 路径分开。Guard 只保护它实际路由的发布操作。`git tag` 与 GitHub Release 没有 Guard 自有路由；要求它们的契约会报告 `release_operation_unrouted`，不会假装宿主命令已受保护。复合 runner 是不透明边界，`/context-guard release` 会报告精确覆盖范围。发布仍需用户授权和宿主检查；插件不能控制绕过其路由的进程内调用。

## 边界

Context Guard 负责完成认证；Goal、Todo、Compaction、continuation、权限和工具执行仍由 DSH 管理。它不是安全沙箱、语义证明系统、token pruning 工具，也不替代这些 DSH 能力。

证据采用有界存储和脱敏处理。Guard 不保存完整 prompt、stdout、文件内容、凭证、Authorization header、URL query value、图片字节或原始 transcript。详见 [`docs/PRIVACY.md`](docs/PRIVACY.md)。

## 与 Codex Context Guard 的关系

本项目最初从 [`GreenLv/codex-context-guard`](https://github.com/GreenLv/codex-context-guard) v0.8.8 移植确定性行为。这个版本只是历史起点，不代表当前兼容程度。

0.4.0 明确对齐了 Codex Context Guard 0.10.0 的共享证据规则：证据必须对应仍未完成的工作，并证明用户实际要求的操作、目标和结果。这只是有边界的行为对齐，不表示两个产品拥有相同功能。

0.7.1 的共享 core/v2 源码和一致性夹具，按 `tests/fixtures/conformance/core_v2/UPSTREAM_PIN.json` 记录的 Codex Context Guard 精确提交进行字节镜像。这只证明所列文件的源码身份，不证明两个产品功能或运行时完全等价；宿主证据与发布仍分别核验。0.6.x 的 C01–C12 契约和 DSH 自行编写的 v2 候选属于历史阶段。当前对照和限制见 [`docs/SEMANTIC_COMPATIBILITY.md`](docs/SEMANTIC_COMPATIBILITY.md)。

两个项目服务于不同运行时：

- `codex-context-guard` 是面向 Codex Hook 的 Python 实现，负责 Codex 插件缓存和 Hook 生命周期接入。
- `dsh-completion-guard` 是独立的 TypeScript 实现，基于 DSH 原生 Session 事件、命令、工具和 Agent 生命周期工作。

两个项目不共享运行时状态、安装器、缓存或发布历史。修复应先进入拥有对应运行时的仓库；只有同一行为确实适用于两侧时，才显式迁移。具体复用与替换边界见 [`docs/UPSTREAM_BASE.md`](docs/UPSTREAM_BASE.md) 和 [`docs/PORTING_NOTES.md`](docs/PORTING_NOTES.md)。

</details>

## npm 下载量历史

![dsh-context-guard 与 dsh-completion-guard 的 npm 累计下载增长](https://raw.githubusercontent.com/GreenLv/dsh-completion-guard/stats/npm-downloads.zh-CN.svg)

累计图分别显示更名前后的 npm 包下载总量，标记 2026-08-29 的更名，并仅在项目增长曲线中合并两者。npm 下载量统计的是 registry 请求，不等于独立用户数或已确认的真实安装人数。

历史从首次公开发布 npm 的 2026-08-26 开始，保留首日真实下载数，不强行归零；纵轴从零起算。日期标签统一居中，按固定天数间隔显示，图注始终保留精确截止日。

每日工作流仅发布至少相隔 12 小时复查一致、且距离当日已有两个 UTC 日历日的数据，另行标明 API 数据可用日期。这是项目的观测规则，不代表 npm 保证数值永不修订。详见[源数据](https://raw.githubusercontent.com/GreenLv/dsh-completion-guard/stats/npm-downloads.json)。

## 文档

- [安装与首次载入](docs/GETTING_STARTED.md) — 安全安装、首次等待及会话模式。
- [`CHANGELOG.zh-CN.md`](CHANGELOG.zh-CN.md) — 面向使用者的版本变化。
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — 所有权、持久状态和认证管线。
- [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) — 支持的 DSH 版本和可认证命令子集。
- [`docs/LOCAL_ACCEPTANCE.md`](docs/LOCAL_ACCEPTANCE.md) — 确定性、隔离环境、原生平台和公开包验证范围。
- [`docs/distribution.md`](docs/distribution.md) — 已验证的公开分发去向与更名说明。
- [`docs/PRIVACY.md`](docs/PRIVACY.md) — 保存的事实、禁止数据和失败行为。
- [`docs/UPSTREAM_BASE.md`](docs/UPSTREAM_BASE.md) — 历史起点与仓库权威边界。
- [`docs/SEMANTIC_COMPATIBILITY.md`](docs/SEMANTIC_COMPATIBILITY.md) — 当前共享行为和已知差异。
- [`docs/PORTING_NOTES.md`](docs/PORTING_NOTES.md) — 从 Codex 保留的行为和 DSH 专属替换。

## 开发

```sh
pnpm install --frozen-lockfile
pnpm --dir tests/fixtures/host-composition install --frozen-lockfile
pnpm run test:stats
pnpm run typecheck
pnpm test
pnpm run lint
pnpm run build
pnpm run pack:check
```

这些命令验证本地源码树与包。CI、原生平台验收、npm 发布、GitHub Release 身份和真实 DSH 环境安装仍是相互独立的证据范围。
