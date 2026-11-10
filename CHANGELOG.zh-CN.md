# 更新日志

[English](CHANGELOG.md)

各条目记录该版本的主要变化和升级要求。当前安装步骤见[安装与首次载入](docs/GETTING_STARTED.md)，各版本核验范围见[验收记录](docs/LOCAL_ACCEPTANCE.md)。

<details>
<summary>版本索引</summary>

[0.13.0](#0130) · [0.12.1](#0121) · [0.12.0](#0120) · [0.11.0](#0110) · [0.10.0](#0100) · [0.9.0](#090) · [0.8.4](#084) · [0.8.3](#083) · [0.8.2](#082) · [0.8.1](#081) · [0.8.0](#080) · [0.7.1](#0712026-09-22) · [0.7.0](#0702026-09-21) · [0.6.3](#0632026-09-18) · [0.6.2](#0622026-09-16) · [0.6.1](#0612026-09-15) · [0.6.0](#060---2026-09-14) · [0.5.3](#053---2026-09-14) · [0.5.2](#052---2026-09-11) · [0.5.1](#051---2026-09-10) · [0.5.0](#050---2026-09-10) · [0.4.3](#043---2026-09-08) · [0.4.2](#042---2026-09-07) · [0.4.1-rc.1](#041-rc1---2026-09-04) · [0.4.0](#040---2026-09-02) · [0.3.2](#032---2026-09-01) · [0.3.1](#031---2026-08-31) · [0.3.0](#030---2026-08-31) · [0.2.1](#021---2026-08-28) · [0.2.0](#020---2026-08-28) · [0.1.2](#012---2026-08-27) · [0.1.1](#011---2026-08-27) · [0.1.0](#010---2026-08-27)

</details>

## 0.13.0

Guard 适配了 DSH `0.2.2-rc.1` 的工具执行和会话接口。一次调用包含多个工具步骤时，Guard 会逐步检查，并等宿主完整保存结果后再将其用作证据。

- **先升级 DSH 和 Node.js。** 最低版本为 DSH `0.2.2-rc.1`、Node.js `24.9.0` 和 Cordis `4.1.0`。DSH `0.2.1` 及更早版本低于要求。更高版本也要核验实际安装环境。已核对的宿主包和 Desktop 安装包见[兼容性说明](docs/COMPATIBILITY.md#0130-dsh-022-rc1)。
- **保留旧会话的启用模式。** 迁移工具支持从已核验的 `0.12.x` 安装迁移。替换 DSH 或 Guard 前，先停止写入会话的进程，保存旧包、模式来源和会话清单。安装后重建并核验宿主锁，恢复并核验旧模式，再启动。见[安装指南](docs/GETTING_STARTED.md)和[迁移指南](docs/ACTIVATION_MIGRATION.md)。
- **已知依赖风险。** DSH 仍包含 Undici 8.11.2 和 Zod 4.4.3。0.13.0 的三条 Undici 临时例外有效至 **2026-11-30（含）**。受影响的宿主仍存在已披露的风险，包括 TLS 1.2 可能引起进程崩溃。详见[依赖风险说明](docs/DEPENDENCY_SCAN.md)。

[验收记录](docs/LOCAL_ACCEPTANCE.md)分别说明宿主包核验、CI 和各平台使用同一份制品的验收范围。

[原版详细记录](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/CHANGELOG.zh-CN.md#0130)。

## 0.12.1

同一旧会话有多代日志时，迁移会核对保留下来的每一代。即使最新日志能打开，较早的一代损坏也会阻止迁移。

- 迁移工具用 DSH 的只读接口核对会话身份和分叉继承的位置，保留原文件和路径。已审查的后端支持普通 JSONL 和 zstd。
- 本版 DSH 下限仍为 `0.2.1-rc.3`，默认审查环境仍为 rc.5 和 Cordis 4.0.5。已披露的三条 Undici 风险仍存在，本版临时接受至 **2026-11-30（含）**。见[迁移指南](docs/ACTIVATION_MIGRATION.md)和[依赖风险说明](docs/DEPENDENCY_SCAN.md)。

[原版详细记录](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/CHANGELOG.zh-CN.md#0121)。

## 0.12.0

`verify.pdf` 这样的文件名本身不会再变成一项验证任务。文件名、路径和链接目标旁边的真实指令仍会保留。

- **迁移时同时核对磁盘日志。** 工具将官方会话列表与所选目录中的原始日志逐一对照，发现漏列的会话或无法读取的布局时停止迁移。请确认所选目录就是 DSH 实际使用的目录。缺少清单完整性证明的旧收据要重新生成。工具支持从已核验的 `0.11.x` 安装迁移。见[迁移指南](docs/ACTIVATION_MIGRATION.md)。
- **默认审查环境改用 DSH rc.5。** 通过核验的 `0.2.1-rc.3` 仍可使用。从 rc.3 升到 rc.5 时，Guard 使用的 47 个包的可执行内容未变。macOS arm64 和 Windows x64 的官方 Desktop 安装包分别核对。详见[兼容性说明](docs/COMPATIBILITY.md#0120-dsh-021-rc3)。
- **已知依赖风险。** 审查过的 DSH 宿主仍包含受影响的 Undici 和 Zod。本版的三条 Undici 临时例外有效至 **2026-11-30（含）**。详见[依赖风险说明](docs/DEPENDENCY_SCAN.md)。

维护者可用已保存的结果补发缺失的验收回执。初始化失败或中断时，保留测试环境供清理排查。CI 按改动范围选择测试深度，Web 和 Headless 原生验收也能在宿主已运行时检查调用路径变化。

[原版详细记录](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/CHANGELOG.zh-CN.md#0120)。

## 0.11.0

本版加强了发包和文件访问检查，并修复了会话目录、配置和指令的多处误判。

- **发包前后核对同一个包。** Guard 会拒绝有歧义的包清单和不支持的 tar 条目，并在授权前读取完整制品。发布后查询 npm 时也设有时间和读取量上限。查不到确定结果时，保留原尝试，等待对账。
- **相对路径按调用时的目录解析。** 即使 Bash 或 PowerShell 指定工作目录，Guard 也会保护自己的私有存储。后来切换目录，先前的结果仍对应原文件。URL 内嵌凭据和已列明格式的 GitHub 令牌会在保存前脱敏。
- **修复会话与配置。** “请分别执行”不再被误读为禁止。普通分叉会话按独立会话处理。某个会话索引条目写到一半中断时，其他已完整写入的条目仍能读取。注入宿主锁会保留 JSON 形式配置中的已有条目，较长的配置也能完整输出到管道。
- **安装本版前升级至 DSH `0.2.1-rc.3` 或更高版本。** 迁移工具兼容 rc.3 的会话存储接口，支持从已核验的 `0.10.x` 安装迁移。见[兼容性说明](docs/COMPATIBILITY.md#0110-dsh-021-rc3-historical-for-this-release)和[迁移指南](docs/ACTIVATION_MIGRATION.md)。
- **依赖风险扫描成为必需的 CI 检查。** 未被接受的高危或严重公告会阻止通过，扫描失败也会阻止通过。本版三条 Undici 临时例外有效至 **2026-11-05（含）**。详见[依赖风险说明](docs/DEPENDENCY_SCAN.md)。

[原版详细记录](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/CHANGELOG.zh-CN.md#0110)。

## 0.10.0

切换工作目录后，先前的结果仍指向原来的文件或测试。如果命令执行期间目录发生变化，且结果依赖该目录，Guard 会将结果留待确认。

- DSH 可以记录后台作业完成、失败或被停止。Guard 用属于本会话的匹配记录结束等待。作业状态本身无法证明清理成功，也无法证明用户要求的结果已经得到核验。
- DSH 的实验性 `plugin:` 记录会保留，但不会用于跟踪任务。收到 Team Inbox 消息或子智能体结果后，父任务仍需核对自己的要求。
- **安装本版前升级至 DSH `0.2.1-rc.2` 或更高版本。** 保留旧模式和设置，重建并核验各配置的宿主锁，核对迁移结果后再启动。本版支持从已核验的 `0.9.x` 安装迁移。Desktop 随包文件的核对范围见[兼容性说明](docs/COMPATIBILITY.md#0100-dsh-021-rc2)。

[原版详细记录](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/CHANGELOG.zh-CN.md#0100)。

## 0.9.0

省略 `activation` 时，新会话从首条消息或附件开始自动保护。想继续手动开启，可以显式设置 `activation: opt-in`。

- **旧会话沿用原来的模式。** 升级前先停止写入会话的进程，按[迁移指南](docs/ACTIVATION_MIGRATION.md)保存旧模式。安装后重建宿主锁，核验迁移结果后再启动。原历史和有效的旧证书都会保留。
- **载入旧会话仍可能需要等待。** 确认历史未变且结果可安全复用时，Guard 会复用已有检查。DSH 仍要读取历史，再次打开时也可能显示“载入历史”。
- 官方读取器拒绝旧格式时，可以[明确选出可读的会话迁移](docs/ACTIVATION_MIGRATION.md)。排除项保留原日志，继续待处理。`selected_complete` 只表示选中的会话通过。

[原版详细记录](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/CHANGELOG.zh-CN.md#090)。

## 0.8.4

官方 Desktop 现在可以同时加载 Guard 和官方插件市场（`dshmarket`）。旧版本可能把这种组合误判为冲突。

安装或移除市场会改变 Desktop 的安装配置。先执行 `inspect`、`inject` 重建宿主锁，再用 `dump-desktop` 生成新配置，最后用 `verify-dump` 核验。Guard 的市场和 Desktop 重启限制仍适用。见[Desktop 安装步骤](docs/HOST_LOCK_UPGRADE.md#official-desktop-profile)。

[原版详细记录](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/CHANGELOG.zh-CN.md#084)。

## 0.8.3

某项证据已经够用、但任务还有其他工作时，完成检查会指出还差哪些结果。参数填错时会给出具体错误，不再打断本轮执行。

- 处理长会话时减少重复解析和宿主检查。确认宿主的事件记录未变时，可复用之前生成的会话视图。载入耗时仍取决于历史和宿主。
- 测试须在用户指定的目录运行，在其上一级目录通过不能算数。Git 命令失败、转入后台或输出被截断时，也无法确认提交或推送成功。
- Guard 私有记录写入中断后更容易恢复。降级时仍须按[写入锁说明](docs/WRITER_LOCK_PROTOCOL.md)执行维护步骤。
- Desktop 重复安装分两步验收。单独重复安装 Guard 时文件须逐字节一致。多包装在一起时，只允许 `.modules.yaml` 的 JSON 对象键顺序变化。详见[验收记录](docs/LOCAL_ACCEPTANCE.md)。

[原版详细记录](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/CHANGELOG.zh-CN.md#083)。

## 0.8.2

官方 Desktop 有了自己的宿主锁。Guard 核对签名应用归档和实际加载的配置。启动前可用 `dump-desktop` 检查组合后的配置。Web 和 Headless 继续走各自的安装流程。

- **安装本版前升级至 DSH `0.2.0-rc.2` 或更高版本。** 升级后为各配置重建并核验宿主锁。见[兼容性说明](docs/COMPATIBILITY.md#082090-dsh-020-rc2-and-official-desktop)。
- 退出标记被后续输出遮挡或格式损坏时，Guard 会将 shell 结果留待确认。

[原版详细记录](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/CHANGELOG.zh-CN.md#082)。

## 0.8.1

Guard 减少了打开会话和重放历史时重复执行的宿主检查。认证完成或允许发包前，仍会核对当时的宿主。

**安装本版前升级至 DSH `0.2.0-rc.1` 或更高版本。** Cordis 至少为 `4.0.4`，且须单独通过核验。重启前重建并核验宿主锁。本版新增了为后续兼容版本重建锁的方式，需要核对官方归档和变化的接口。详见[宿主锁指南](docs/HOST_LOCK_UPGRADE.md)。

[原版详细记录](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/CHANGELOG.zh-CN.md#081)。

## 0.8.0

Guard 适配 DSH `0.1.7-rc.2` 和 Cordis `4.0.4`。安装本版前先升级 DSH，重启前为各配置重建宿主锁。

- Goal 的完成提示会指向可核验的具体文件回读或前台测试结果。
- Shell 输出不完整时保持待核验。只读发现和完成查询自身产生的观察没有改变任务时，可以继续翻页。
- [源码阶段记录](https://github.com/GreenLv/dsh-completion-guard/blob/563f144bf8568793da5017b9ff71395a33dcd265/docs/DSH_0_1_7_RC2_ACCEPTANCE.md)记录开发阶段的检查。原生验收结果绑定到对应的发布制品。

[原版详细记录](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/CHANGELOG.zh-CN.md#080)。

## 0.7.1（2026-09-22）

### 变更

- 恢复提示与 prepare、checkpoint 使用一致的当前结果。已完成的测试不再被提示缺少证据；普通任务也不会仅因无法认证而被引向补充目标、重新绑定等操作。
- 当前结果不可用时，仍保留来源可核验的当前禁止事项及用户等待；短消息优先展示这些边界，并报告折叠数量。过长的边界可通过只读详情查看完整原文；历史兄弟任务不会重新成为当前限制。
- 恢复提示保留“仅清理已证明无依赖的对象”的条件，不能把部分删除或依赖未知说成清理完成。要求发生变化时，提示明确说明更新，不再误称发生了压缩或恢复。
- prepare 区分历史记录中的等待与当前适用的等待，并在完成状态未知时继续核验条目版本。禁止项的遵守状态无法核验时，prepare 和 checkpoint 仍明确保留禁止含义。

### 升级与限制

受支持的 DSH 版本仍为 `0.1.5-rc.2 || 0.1.5-rc.1`。更新插件后请重启 DSH。已有历史记录保留，显式 proof、已采用的 Goal 和 release 检查仍分别生效。部分复合自然语言等待句仍无法识别；本补丁也不证明模型在压缩前回答插问后一定会正确续接主任务。源码检查及精确制品证据边界见[验收记录](docs/LOCAL_ACCEPTANCE.md)。

## 0.7.0（2026-09-21）

### 要点

- 普通编辑、测试和 Git 操作由宿主工具完成。Guard 保存要求、观察已持久化的结果与精确回读，只认证相符的完成谓词。
- Stop 区分已就绪的当前动作、未来观察与证据不足。简短继续指令仅在具体动作就绪时允许一次继续；恢复时不把旧 generic 项或文本推导的等待升级为可信事实。
- 新 v6 会话的 Goal 完成保护需要显式 `/context-guard on` 采用；后来失败的必需结果会阻止旧证书完成当前 Goal。已采用的 release 合同和显式 proof 要求仍独立保护。

### 变更

- core/v2 消费端按 Codex Context Guard 提交 `cb415cbe374d452e4a0c71e9e292d20e31f23b0e` 精确镜像共享源码与一致性夹具。旧 v1 pin 和 v5 历史保持原状；源码身份不等于两个产品完全等价。
- 普通 `context_guard_action` 与 `context_guard_evidence` 调用改为返回迁移说明。文件、测试和 Git 效果由 DSH 宿主工具执行；只读文件、Git 与包脚本观察仅为具名完成谓词提供事实。输入就绪不证明测试已运行，也不证明用户要求的时间或审批条件已满足。
- 相对文件要求保留根时 Session 位置，精确文件系统回读确认目标。宿主确实修改禁改文件时，即使允许的编辑成功也仍属违例。宣称新建文件前仍需可信的写入前不存在证据。
- 编辑、测试、回读与答复交付各保留独立义务。简短恢复或取消只改变有源范围内的工作；未来观察及旧 generic 项不会在重载时变成当前授权。普通结果已经满足时，默认反馈不再索要旧绑定。
- 本轮要求解释未来观察时，该解释可由本轮可信答复完成。分句和恢复仍保留其来源与条件；引用或带条件的解释不会变成新的当前指令，独立要求的测试仍需自己的实际结果。
- 具名的前台 `npm test` 或 `pnpm test` 经精确宿主渲染器和终态核验，可满足“运行并报告”。“使测试通过”仍需实际通过；其他包脚本的数值和未知退出状态不予认证。显式 proof、已采用的 Goal 完成和适用的 release 合同各自保留检查。
- 前台渲染器审计现在同时识别官方 Windows DSH rc.2 的提升式 package-map 布局与 pnpm 带版本的布局。它仍要求唯一可达包、受支持的精确版本、位于受控目录内的物理模块及匹配的实现字节；这项源码修复本身不代表 Windows 原生验收通过。

- 宿主观察通知在整批工具结果之后交付，不再插入尚未结束的工具调用。已采用的 release 与 restart 控制记录使用独立的私有持久账本；保留会话状态时应同时保留该账本。记录缺失或损坏时，受保护操作保持未决，不会把已消费操作重新视为可用。

### 验证

候选 `583035bd90b8ee589d01b12487a057b655d43e41` 通过完整本地确定性矩阵、候选 CI，以及同一干净源码 tgz 的 macOS 原生 34 项门禁和清理。该原生运行跳过真实模型请求；该 tgz 字节没有执行 Windows 同一制品及完整模型验收。若打包文档或源码改变，这些结果只属于原字节。正式发布以最终精确 tgz 通过其自身的确定性、CI、原生平台和模型验收为前提。tag、npm 包与 GitHub Release 在验收后发布；公开读回和日常安装属于随后分别核验的步骤；详见[验收记录](docs/LOCAL_ACCEPTANCE.md)。

## 0.6.3（2026-09-18）

Guard 核对用户授权的操作及其对象。准备和执行两步对所需输入、哪些旧记录还可以使用，采用同样的规则。发布状态及同一制品的原生验收证据见[对应 Release](https://github.com/GreenLv/dsh-completion-guard/releases/tag/v0.6.3)；[本地验收记录](docs/LOCAL_ACCEPTANCE.md) 保留源码检查。

### 变更

- **只有独立识别出的指令才能获得执行资格。** 疑问、解释、转述与引用命令不授予执行权限；动作仍处于这些范围内的混合请求保持未决，普通回答不能将其关闭。需要执行时，请另起一句或用分号分隔独立指令。资格持久保存，子项只能继承而不能提升，prepare 与执行共用它。此项有意收窄自动授权范围，详见[合同修订说明](docs/CONTRACT_REVISION_0_6_3.md)。
- **会话工作目录不再等于用户选择的目标。** 义务的目标现在带有来源：显式名称或路径、明确选择当前仓库的表达、受信宿主选择，或来自同一工作单元内另一义务的唯一可审计选择。子句未指明仓库的 Git 动作只把该目录作为环境上下文保留，因此仍是目标待澄清，而不是为根用户未选择的变更放行。多个同源候选保持歧义；指向另一仓库仍被拒绝。
- **prepare 与执行共用同一兼容判据。** `context_guard_prepare` 用变更门禁所执行的同一判据评估当前条目、动作、修订与目标：假设与义务记载不符时返回 `incompatible` 并指出条目自身的动作，只返回标注 `recipe_only` 的调用者假设手册；调用者提供的目标与条目自身目标不同时按“提议”报告，不作为授权。
- **按旧规则捕获的记录不再被继承为通过。** 升级资格检查在任何终态过滤之前执行，覆盖开闭包计算会跳过的记录，包括已 `answered` 的记录。自身文本仍包含执行要求、或 Git 目标缺少可审计来源的记录被标记 `needs_review`：历史状态原样保留，不重放任何动作，并阻断新证书与 Goal 完成结论，而不是只给旁路警告。未知状态版本会被报告，不再假定兼容。
- 如实重述 Codex 对齐范围。新增实测记录执行已安装 Codex 模块自身的纯回答交付判据（12 条共享输入，`tests/fixtures/cross-end/codex-0.13.9.shape.json`），跨端台账逐族记录实测结论。本批 12 条 Codex 全部拒绝以此方式关闭，故混合请求与纯问句两族记为关键方向上的 `not-aligned`，`trusted-answer-delivery` 从 `aligned` 下调。
- **目标唯一性覆盖全部身份字段。** 候选按各字段的身份规则处理大小写；包规格同时贡献包名和版本。普通捕获、重述及动作计划的每一项都拒绝冲突选择。重述把新动作与新目标一起绑定，仅从唯一来源继承省略的字段。

### 升级与验证

动作仍处于疑问或解释范围时，请将要执行的动作写成独立指令。缺少执行资格的旧记录需要复核，不重放历史动作。支持的 DSH 版本仍为 `0.1.5-rc.2 || 0.1.5-rc.1`。

最终源码测试为 2140 项通过、1 项跳过。历轮修复、合同调整与证据边界保留在[本地验收记录](docs/LOCAL_ACCEPTANCE.md)；源码检查不能代替对应 Release 附带的精确制品原生验收附件。

## 0.6.2（2026-09-16）

### 变更

- 普通任务没有认证适配器时，明确报告能力限制，不再要求用户改说另一动作或重绑定。prepare、checkpoint、恢复包和 status 共用诊断。
- shell 证据分开报告历史 outcome、明确声明的进程结果与操作归属；checkpoint 同时输出来源和冲突标记。旧 outcome 规则与摘要输入保持不变，不透明复合命令不会因最后退出成功获得逐操作成功结论。
- 最小预算的恢复包也保留“仅删除已证明无依赖对象”的条件；元数据、内容、目录与依赖状态分别报告。不新增删除执行器或普通工具审批。
- Codex 有界对照新增隔离合成账本，实测 pending、用户等待、缺证纠正及同一混合结果。它证明函数级行为，不等于原生验收或全功能对齐，详见[结果合同](docs/CROSS_END_RESULT_CONTRACT.md)。
- 清理重复修复笔记和已被替代的 0.6.1 计划；历史引用保留精确 Git 快照，当前限制集中在语义兼容说明与发版计划。

### 验证范围

准备时，本条目记录的是源码发布候选。本地结果与当时尚缺的 CI、T06 原生、精确制品和发布门槛见[验收记录](docs/LOCAL_ACCEPTANCE.md)及[发版计划](https://github.com/GreenLv/dsh-completion-guard/blob/784b5452b0da366a351dff6490fa46eeed2839a9/docs/RELEASE_PLAN_0_6_2.md)。

## 0.6.1（2026-09-15）

修复 Windows 0.6.0 复核发现的附件处理、保守解释、发现分页和证据诊断问题。

- **附件可以通过解释与回答关闭，无需改绑执行动作（W060-01）。** 每项附件需要 `context_guard_interpret` 解释记录，以及解释所在 turn 的正常回答；旧附件也可由后续 turn 处理。重放核对条目、revision、资产身份与调用/结果 turn 对。身份或 turn 矛盾使 projection 无效，缺失 turn 关联则不记录。资产回执不得带子句划分字段。解释记录是模型的声明，不是视觉准确性的独立证明。
- **无法解析的请求保持 pending（W060-02）。** 未知子句不再默认可执行。解释和混合请求可通过 `context_guard_interpret` 提交 `information_spans` 与 `unknown_spans`；工具检查范围和重叠，重放要求回执与调用划分一致。信息子项由解释 turn 的回答关闭，未知与未申报区域继续保留。划分的语义正确性仍由模型负责。根用户澄清、确认重绑定与 clear 通路保留；“当然。”等普通应答属于会话内容，不形成义务。
- **发现结果支持完整分页（W060-03）。** `context_guard_prepare` 按稳定顺序每页列出八项，提供绑定 revision 的 cursor 和明确的 `semantic_action` 筛选。沿 `next_cursor` 遍历当前单元适用集合；revision 改变时重新发现。历史项仍可按 ID 查询。
- **只读验证只需一条 effect 角色事实（W060-04）。** prepare、诊断与认证器保持一致。状态变更仍需 resolution、effect、state 证据；只读检查不再被误报为缺少历史前态。
- **无法归属的 shell 执行保持未认证（W060-05）。** 匹配的命令头信号触发 `execution_unattributable`，要求先只读核实现状，不断言动作已发生或未发生。复合命令文本不作为执行证明。受保护的 push、pull、fetch 在引用状态已满足时拒绝调用 runner，报告 `action_already_applied`，不通过重做补造证据。普通工作不需要额外 Guard 审批。

### 兼容与验证范围

解释记录和原因码为增量。附件捕获文本保持 0.6.0 字节；旧日志没有解释记录时，附件继续 pending。源码检查、CI、冻结制品和原生 Web/Headless 验收分别记录在[验收记录](docs/LOCAL_ACCEPTANCE.md)。测试宿主清理现在显式释放持久化宿主，避免 FileHandle 被垃圾回收时报错。本节不代表任何平台验收或发布已经完成。

## 0.6.0 - 2026-09-14

Guard 开始分别记录已交付的答复、委派工作和恢复后的任务。答复已交付就能关闭相应的回答项。子任务结果可以支持父任务的检查，但父任务仍须完成自己的要求。

- 已保存的结果须与指定动作和对象相符。检查图片、文件、网址或外部状态时，需要来自对应来源的证据。宿主无法提供时，Guard 会说明缺口。
- 之前的禁止事项继续约束对应工作。恢复时会读取已记录的要求、结果以及必须完成的子任务。
- 明确采用发布合同后，Guard 将每项受覆盖的操作绑定到确切候选版本，先记录执行尝试，再核对执行结果。
- 本版采用了部分共享的 Context Guard 行为，并保留旧历史的原有含义。原版条目记录了本版的各轮修复和检查范围。

[原版详细记录](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/CHANGELOG.zh-CN.md#060---2026-09-14)。

## 0.5.3 - 2026-09-14

宿主报告能力时即使没有附带原因码，准备检查也能继续。对于 Git 操作，Guard 会列出所需输入和顺序，区分它能自己读取的信息和你需要指定的目标。

[原版详细记录](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/CHANGELOG.zh-CN.md#053---2026-09-14)。

## 0.5.2 - 2026-09-11

安装包只声明支持 Guard 当时能识别的两版 DSH：`0.1.5-rc.1` 和 `0.1.5-rc.2`。Guard 仍会核对完整的宿主包。任务跟踪和完成检查沿用 0.5.1 的规则。

[原版详细记录](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/CHANGELOG.zh-CN.md#052---2026-09-11)。

## 0.5.1 - 2026-09-10

Guard 改用 DSH 第三版会话格式。从 DSH `0.1.2-rc.1` 升级时，请新建会话，并保留旧日志、提案和证书供查阅。

- 安装包要求 DSH `0.1.5-rc.1` 或更高版本。运行时还会核对 rc.1 和 rc.2 已登记的完整包组合。npm 能安装的版本也可能无法通过运行时核验。
- Guard 识别新版工具分派事件，以及持久 shell 的退出、超时和内存耗尽标记。
- 用户暂停的 Goal 保持暂停。恢复会话时，仍会先提示待确认事项，再提示如何补充证据。

[原版详细记录](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/CHANGELOG.zh-CN.md#051---2026-09-10)。

## 0.5.0 - 2026-09-10

在 `always` 模式下，Guard 从首条真实消息或附件开始保护。新会话还没发消息时可以先选 DSH 预设，随后第一步工作就会纳入检查。

- `context_guard_prepare` 在执行前列出操作需要的条件。过去的操作缺少证据时，它会指出缺口，无需重复执行。
- 确认重绑定的那一行后，可以空一行再提出新任务。拆分后各部分仍无法认证时，Guard 会直接说明拆分没有帮助。
- 本版适配 DSH `0.1.2-rc.1` 和 Cordis `4.0.2`，可以检查 Headless 的平铺包安装。旧记录仍按原有规则读取。

[原版详细记录](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/CHANGELOG.zh-CN.md#050---2026-09-10)。

## 0.4.3 - 2026-09-08

- 将精确的 DSH 核心锁与可选 market 版本分离。回放时重新读取实际核心依赖图；核心依赖变化、缺失或重复仍拒绝认证。
- 显式版本化核心锁策略和 market 服务适配器。保留历史记录，迁移时重新验证锁并重新获取重启凭据。
- market 重启要求可信的已加载实例绑定。当前 DSH 没有该绑定，因此仅该适配器不可用；用户要求的重启不会被静默判为完成。
- 原生验收显式选择目标，只读核对传入的日常 profile，并在不安装 market 的 Headless 中验收。
- 安装前只读检查支持未声明外部依赖的 DSH `0.1.2-rc.1` Headless profile。检查内置 bundle 的实际安装来源，不补建 profile 文件；已安装插件的 profile 仍必须具备完整的包映射与锁文件。
- 修正历史 0.4.2 发布标记，区分磁盘安装与运行验收。

## 0.4.2 - 2026-09-07

- 对不能认证的任务说明原因和澄清方法。普通命令成功仍不能证明更新完成或 GUI 效果正确。
- 新增 `context_guard_rebind`：提出完整的旧要求拆分方案，可关联用户随后明确给出的澄清要求；只有用户精确确认后才替代旧项。保留旧来源、未支持部分和一对多关系，提案本身不授予执行权限。
- checkpoint 每页不超过 12 KiB，默认只列当前动作和对象相关的证据。要求、证据和历史分别分页，但认证仍检查完整合同。
- 恢复时为当前限制、拒绝原因、下一步和完成规则预留空间。无关证据不会重复触发同一提示，compact 与 resume 仍恢复当前状态。
- 增加隔离的宿主原生验收入口，包含非空工具调用和生命周期检查。验收绑定精确候选和包，详见[验收范围](docs/LOCAL_ACCEPTANCE.md)。

- 修正 npm 图表日期标签：统一居中与固定天数间隔，保留首日真实下载数，并区分已复查区间和 API 可用日期。

## 0.4.1-rc.1 - 2026-09-04

- 新增精确的 DSH `0.1.2-rc.1` + dshmarket `1.41.0` 宿主队列，覆盖 macOS/posix 与 Windows。Windows 宿主图谱已在原生 Windows rc.1 运行时上审计；宿主图谱审计不能替代同一冻结包的跨平台 exact-artifact acceptance。
- 通过 rc.1 的 `snapshotEvents()` API 读取会话历史，同时保留此前已审计 DSH 队列使用的旧版 `events` 路径。

## 0.4.0 - 2026-09-02

Guard 会核对证据是否来自你要求完成且尚未完成的工作。另一个会话、操作或对象的结果无法关闭这一项。文件变化或记录损坏时，已经提交的证据也可能失效。

本版适配 DSH `0.1.2-alpha.3`、dshmarket `1.39.0` 和 Cordis `4.0.2`。macOS 与 Windows 原生验收和 npm 发布使用同一份冻结包。详见[验收记录](docs/LOCAL_ACCEPTANCE.md)。

[原版详细记录](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/CHANGELOG.zh-CN.md#040---2026-09-02)。

## 0.3.2 - 2026-09-01

### 新增

- **可识别两套精确的 DSH 环境。** `0.1.1-rc.2` + dshmarket `1.36.0` 与 `0.1.2-alpha.2` + dshmarket `1.38.1` 两套包集合均已在 macOS 和 Windows 检查。
- **必须完整匹配整套包。** 每个必需包都必须恰好出现一次，并具有预期版本和完整性值。缺包、混装、重复、缺少身份或未知包都会让整个宿主保持不可用，不会只启用部分 Guard。状态会列出缺少的包，切换环境也会使旧完成证书失效。

### 变更

- peer dependencies 只接受两套已检查版本（`0.1.1-rc.2 || 0.1.2-alpha.2`，Cordis `4.0.1 || 4.0.2`）。源码对比未发现 Guard 使用的 DSH 事件、Goal 调用、工具定义或终端结果发生变化。

### 修复

- **发布打包现在兼容 Windows tar。** 解包时改用相对于临时工作目录的路径，不再把归档绝对路径传给 tar；包内文件不变。

### 验证

- 候选提交 `22cde610` 已通过 Ubuntu、macOS、Windows 和 Node.js 22/24 的六项 CI 矩阵。20 个测试文件全量通过 359 项，macOS 跳过 1 项仅适用于 Windows 的测试；Windows 原生核对 alpha.2 的 34 行包清单全部匹配，没有缺失、额外或重复项。
- 冻结的 26 文件包（181157 字节，SHA-256 `feb7fc29799820e08dfe6d2bdb94823e745df9b5aa7c34d46262e5df30dabac4`）已用同一份字节在原生 macOS 和 Windows 完成隔离 Web 与 Headless 生命周期验收。annotated tag、npm 包、GitHub Release 和重新下载的公开文件均指向同一提交与工件；详见 [`docs/LOCAL_ACCEPTANCE.md`](docs/LOCAL_ACCEPTANCE.md)。

## 0.3.1 - 2026-08-31

### 修复

- **冻结 npm 工件现在携带精确源码提交。** release packer 会先构造 npm 文件集，在 staging 包 manifest 中注入完整 40 字符 Git HEAD，再重复打包两次；只有两个 tgz 逐字节一致才通过。registry mutation 前还会生成 SHA-256 校验文件与机器可读工件记录。
- **不把未闭合的 0.3.0 publication 提升为完整 release。** 其 npm 工件仍可安装，并已通过原生平台同字节验收，但 registry 缺少 `gitHead`；因此不为 `v0.3.0` 创建 GitHub Release。0.3.1 在不移动旧 tag、不尝试复用旧 npm 身份的前提下取代该已消费版本。

### 验证

- 冻结的 0.3.1 包已通过 macOS 和 Windows 原生生命周期检查，并已发布到 npm 和对应 GitHub Release。精确工件与公开读回证据见 [`docs/LOCAL_ACCEPTANCE.md`](docs/LOCAL_ACCEPTANCE.md)。

## 0.3.0 - 2026-08-31

### 新增

- **高影响变更必须匹配用户的精确要求。** 包、文件、服务和 Git 操作会绑定到一个目标和预期结果；普通命令成功不能替代另一个动作的完成证据。
- **变更后必须独立读回。** 安装、更新、文件修改、重启、Git 和发布操作需要同时证明预期动作与最终保存状态，才能关闭要求。
- **只读检查和实际变更使用不同工具。** 查询目标不会自动产生修改权限。变更必须对应当前根用户要求；禁止项和验收条件不能提供这份授权。
- **双语 npm 下载量历史。** 每日累计图分别保留更名前的 `dsh-context-guard` 与当前 `dsh-completion-guard` 包总量，同时呈现一条项目增长曲线。采集器会先核对 npm range 与 point 响应，再发布英文和简体中文 SVG。

### 修复

- 助手措辞不再决定 DSH 是否继续任务。只有已保存的等待或延期状态才能结束当前轮次，同时保留未完成要求。
- DSH 包身份缺失、未知或发生变化时，受影响的 Guard 能力保持不可用。进程内部直接写 Goal/session 会被报告为完整性问题，但不声称一定能够阻止。
- 宿主身份注入可重复执行，折叠 YAML 中的完整性值可以正确读取，新建空 profile 也能安全更新。
- 包发布和文件修改会在操作前绑定预期目标，并拒绝已变化的输入或不同的最终字节。
- Windows 操作会固定命令包装器和系统命令解释器，执行时复用已检查路径，不再重新搜索。
- npm 统计发布器现在会在 checkout 前拒绝非默认 ref，把只读采集与具有写权限的发布 job 隔离，采集阶段不持久化凭据，并把全部官方 Action 固定到不可变提交。

### 变更

- **包名由 `dsh-context-guard` 更名为 `dsh-completion-guard`。** 另一个无关 DSH 插件已经使用旧名称。内部 Cordis bundle id 仍为 `context-guard`，已安装 profile 的运行时身份不受影响；旧 npm 包的所有已发布版本均已标为弃用，并引导读者使用新包。

### 验证

- 运行时源码提交 `4f079499509822425c80e0b5ab98d1ebc58da9d5` 的 19 文件确定性测试在 macOS 通过 351 项并按能力跳过 1 项 Windows-only 测试，在原生 Windows 通过全部 352 项且无跳过；其中包含 37 个 portable semantic case 和 29 个 digest vector。
- 提交 `a33b69326eb46fbefc56affc55e2a486695f545c` 生成的 canonical 预发布工件 `72d848e313a0e35e06fd1f493215cc0338b86a79a8001a4f07156e782157fe08`，以同一字节在 macOS 与原生 Windows 通过隔离 Web/Headless 安装、host-lock 读回、真实 dshmarket 重启、HTTP 恢复与清理。CI run 33320743166 在 Ubuntu、macOS、Windows 的 Node.js 22/24 组合上通过该精确提交。
- 带凭据的真实模型会话产生了有效 evidence binding，并验证持久化 typed boundary 接受与同一 Goal 的 disarm 读回。一个刻意过宽的提示词保持 incomplete，且未被错误签发完成证书；该有界结果不表示任意模型指令都能获得语义认证。
- npm 统计套件的 8 项聚焦测试覆盖日期切块、响应规范化与核对、scope 包 URL、上游失败以及失败时保留上一组输出。发布打包会冻结一份包含文档的 tarball，供原生平台验证与 registry 发布；公开 checksum 与 registry integrity 标识这份精确字节。

## 0.2.1 - 2026-08-28

### 修复

- **澄清提问与会话推进语不再污染合同。** 纯推进语（`继续`、`continue`）、元问题（`这个收尾具体要做什么`、`是不是bug`）与元评论/质疑被归类为会话层话语，不再成为合同条目——混合消息中的会话层分句同样被剔除。真实指令、禁止项与任务标题的捕获行为完全不变；措辞拿不准时分类器保守 fail-closed。
- **被拒的 checkpoint 不再重复注入同一恢复包。** 恢复注入按内容去重：摘要绑定恢复包内容、合同修订与 epoch。resume、压缩、启用切换、新证据或新合同修订仍必然再次提醒。

### 新增

- **`/context-guard clear`。** 将当前所有 pending 的 requirement/acceptance 以 `CLEAR:<revision>` 哨兵标记为 superseded（prohibition 保留）并递增合同修订，使空绑定 checkpoint 可以通过认证、Goal completion 在守卫保持开启的情况下放行。该命令与其他状态一样从日志重放。

### 变更

- Goal 完成门禁语义不变（无当前证书不放行），并补充文档化的三条善后路线：用户确认完成后 `/context-guard off`、`/context-guard clear`、如实记录 `update_goal(action=blocked)`。

支持语法见 [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md)，发布证据和平台边界见 [`docs/LOCAL_ACCEPTANCE.md`](docs/LOCAL_ACCEPTANCE.md)。

## 0.2.0 - 2026-08-28

### 新增

- **按会话 cwd 归因证据。** 当 shell 工具未提供 `workdir` 时，证据会归因到会话 cwd，使相对路径操作和无路径检查能够匹配实际运行所在的仓库。
- **在不扩大信任边界的前提下支持更多检查。** 字面量 `2>&1`、选定的只读检查命令和白名单 PowerShell 外部命令现在可以产生可认证证据；复合命令、变量、文件目标重定向、in-place `sed` 和非白名单可执行文件仍不支持。
- **过程动作和诊断结果可认证。** 拉取、安装、提交、推送、发布和重启等动作映射到 run 证据；`python -m unittest`、`doctest` 和 `pytest` 的确定性检查会被识别。被拒的 checkpoint 绑定现在提供可执行提示；DSH 提供结构化退出信息时，Guard 会优先使用这些信息。
- **长会话恢复更清晰。** 信息性回执不再变成意外任务，`--help` 被视为检查说明而不是通过的验证，超长恢复包会安全折叠，同时暴露证据的 `outcome` 和 `capabilities`。

### 变更

- 命令面集中由一个随包发布的 manifest 定义并自校验，并针对真实复合 shell 工作流保留回归测试。解析继续 fail-closed：无法支持或只能部分理解的语法不会产生可认证的 executable 或 operation。

支持语法见 [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md)，发布证据和平台边界见 [`docs/LOCAL_ACCEPTANCE.md`](docs/LOCAL_ACCEPTANCE.md)。

## 0.1.2 - 2026-08-27

### 修复

- 干净成功协议现在覆盖 persistent shell 渲染器的完整终端词汇表：`[shell exited: code N]`、`[shell killed by signal: S]`、`[shell exited]` 以及 persistent 超时报告（`Your command timed out after N seconds or experienced an OOM error. Below is partial output:`）在被其散文重置行（`The persistent bash shell was reset; ...`）包裹时也会被识别为终端事实，不再被误判为干净成功。仅回显重置散文的干净结果仍视为成功；0.1.1 会话渲染器标记保持不变。

## 0.1.1 - 2026-08-27

### 修复

- 对于固定 DSH 渲染器产生的前台 `bash` 完成结果，只要不存在 error、超时、沙箱拒绝、信号、中断或非零退出 marker，现在即可作为成功证据。后台执行和未经验证的通用 `shell` 别名仍然 fail-closed；不受支持的命令语法依旧不能认证合同。

## 0.1.0 - 2026-08-27

首个面向 DeepSeek Harness 的任务合同与完成认证插件版本。

### 新增

- 从用户直接消息中捕获 requirement、acceptance 和 prohibition，并为每项建立具体的验证对象与 surface。
- 只从已持久化的 `tool/call` 和 `tool/result` 事件派生有界证据，包括 capability、subject、surface 和摘要哈希。
- 采用 fail-closed 完成认证：空证据绑定、缺失或过期证据以及无关对象证据都会被拒绝。
- 增加 Goal 完成门禁：启用期间，`update_goal complete` 必须持有当前证书；同时增加带续做次数上限的回合停止门禁。
- 在 compaction 或 resume 后注入恢复信息。

### 变更

- 初始启用状态来自有效的 `activation` 配置；后续持久化 Guard 状态从 DSH 原生事件派生，包括 `command/run`、`user/message`、`tool/call` 和 `tool/result`。Context Guard 不再追加当前持久层无法重新加载的自定义 `context-guard/*` 事件，因此恢复受保护会话不再依赖上游事件注册接口。
- 捕获内容在持久化前会脱敏凭证、Bearer token 和 URL query string，与隐私合同保持一致。
- 退出码证据采用最后一个已记录 marker；回显的伪 `[exit code: 0]` 不能覆盖真实尾部失败，回显或后台运行的检查命令也不能充当确定性验证。
- 重放时重新验证证书：认证结果从重新派生的证据计算；无法再次成立的证书会把 projection 标记为 `corrupt` 并 fail-closed。

### 修复

- 同一扫描中捕获的两个 requirement 不再复用同一个 ID 和修订号；相同内容的再次陈述会在新修订中显式 supersede 旧条目。
- Guard 关闭时不再触发 Goal 完成门禁。
- 裸完成声明（如 `Done.`、`搞定了。`）会触发门禁；带后续行动意图的阶段性声明不再被当成整任务完成。
- Code Mode dispatch 的根调用 ID 会随证据保留，不再错误绑定到内部调用 ID。

### 发布材料

- 完整 Apache-2.0 许可证、CI workflow 和更新日志；npm 包包含 `docs/`。
