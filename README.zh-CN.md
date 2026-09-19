# dsh-completion-guard

[English](README.md)

> **0.7.0 源码候选（未发布）。** 此候选包含共享 core/v2 消费端、原生宿主回读及 Stop/Goal 迁移开发；共享源码镜像已绑定 core/v2 pin 所记录的 Codex Context Guard 提交。DSH 候选尚未安装到日常宿主、完成原生验收或发布。下面的 0.6.3 安装说明对应当前已发布版本。

对 0.7.0 候选，普通编辑、测试及 Git 工作由宿主工具执行。Guard 观察其已持久化结果，并提供只读文件、Git 与包脚本就绪回读；后者可以从当前工作单元选择测试或评估输入，不强迫重新编辑。相对文件和目录要求保留原始范围，并需根时 Session 定位来源及文件系统规范路径回读；非路径测试目标单独记录。宿主若确实编辑了明确禁止的文件，即使要求的编辑也完成，该违例仍阻断完成；助手自述不能生成这一宿主事实。旧版普通 `context_guard_action` 和 `context_guard_evidence` 调用不产生业务效果，只返回迁移诊断：改用宿主工具，再依据其已持久化结果及必要的只读观察核验 checkpoint。`context_guard_prepare` 仅作诊断，不为普通工作提供执行配方。匹配的 checkpoint 只关闭证据实际证明的谓词。未来观察仍属未来；即使文件或脚本就绪，根要求中的时间或审批条件仍保持待满足。简短“继续”只在具体动作就绪时推进。显式 `/context-guard on` 采用 Goal 完成保护；只有显式采用的 release 合同继续由 Guard 的受控发布门禁保护。下文 0.6.3 的旧流程说明对应已发布版本。

修改、受支持的测试、文件回读与最终回答交付可以分别核验。创建文件还需要可信的写入前不存在证据；写入后的回读不能单独证明这一前提。运行其他具名包脚本仍是当前请求，但测试／基准观察器不会认证该脚本的数值输出。

面向 DeepSeek Harness（DSH）的任务保护插件。它保存任务要求，并在任务标记完成前逐项核对；会话恢复后仍使用同一份检查表，只有匹配的已保存工具结果才能作为证据。

![任务合同条款与有界证据通过 checkpoint 匹配后签发完成证书](assets/social/completion-guard-hero.png)

## 快速开始

安装 **0.6.3** 前，请先确认对应的 [GitHub Release](https://github.com/GreenLv/dsh-completion-guard/releases/tag/v0.6.3) 已发布。Release 提供精确制品身份与平台验收结果；[源码验收记录](docs/LOCAL_ACCEPTANCE.md) 保留开发阶段的检查。

```sh
dsh plugin --profile web add dsh-completion-guard@0.6.3
```

**先升级并重启 DSH，再执行下面的宿主锁检查。** 宿主锁记录 DSH 实际使用的包版本和安装目录；如果升级前就生成锁，新运行时会因包版本不匹配而拒绝它。`inject` 会修改 `<profile>/cordis.patch.yml`，请先备份该文件。

查看每条命令 JSON 输出中的 `status`，确认它为 `supported`。`inspect`、`inject` 和 `verify-dump` 即使报告 `unsupported`，退出码也可能为 `0`，因此不能只看命令是否正常退出。

```sh
DSH_RUNTIME_ROOT=/absolute/path/to/.dsh-runtime
DSH_PROFILE_ROOT=/absolute/path/to/.dsh/profiles/web
GUARD_HOST_LOCK="$DSH_PROFILE_ROOT/node_modules/.bin/dsh-completion-guard-host-lock"

"$GUARD_HOST_LOCK" inspect --runtime-root "$DSH_RUNTIME_ROOT" --profile-root "$DSH_PROFILE_ROOT"
"$GUARD_HOST_LOCK" inject --runtime-root "$DSH_RUNTIME_ROOT" --profile-root "$DSH_PROFILE_ROOT"
dsh --profile web --dump-config | "$GUARD_HOST_LOCK" verify-dump --runtime-root "$DSH_RUNTIME_ROOT" --profile-root "$DSH_PROFILE_ROOT" --dump-config -
```

Windows 请通过 Web 配置目录下的 `node_modules\.bin\dsh-completion-guard-host-lock.cmd` 运行相同的三个子命令，并使用 Windows 绝对路径。各版本的原生验收与发布证据在[验收记录](docs/LOCAL_ACCEPTANCE.md)中按版本绑定其精确制品字节单独记录；任何版本的源码与确定性证据都不能等同于该版本已安装制品的结论。其他宿主版本和制品仍需各自的原生证据。DSH、Guard 或 profile 路径变化后需要重新检查；仅 market 普通升级不需要重新注入。如果当前包集合缺失、混装、重复或不属于已检查环境，Guard 会保持不可用。

然后重启 DSH Web，打开会话并启用 Guard：

```text
/context-guard on
/context-guard status
```

默认采用 opt-in。`status` 显示 Guard 是否开启、启动阶段（`armed` 表示已就绪、等待你的第一条消息）以及还有多少检查项。`off` 停止保护当前会话，但不删除历史。`clear` 关闭当前待办，同时保留禁止项。`diagnose` 说明完成检查为什么通过或失败；`migration` 报告当前会话适用哪套规则、升级与回滚分别意味着什么；`release` 报告显式发布契约、其覆盖范围以及仍在执行中的操作。

## 它保护什么

- 保存需求、验收条件、禁止项和后续修正，不覆盖旧记录。
- 只使用 DSH 已保存的工具调用和结果，并保存脱敏摘要而不是完整输出。
- 只有动作和结果对应指定命令、文件或其他目标时，证据才有效。
- 会话重建或恢复后重新检查完成状态；记录损坏时拒绝签发证书。
- 当前检查表尚未通过时，阻止 Guard 自己守卫的 Goal 完成路径。DSH 内部仍可能绕过这条路径，因此插件会报告这些情况，不声称能阻止所有写入。

## 状态与兼容性

0.6.3 仅支持 **DSH `0.1.5-rc.2` 或 `0.1.5-rc.1`**（配合 Cordis `4.0.2`），两者分别是当前已注册的最新版本和验证过的最低版本。旧 Session API、V2 事件词表和所有更早的宿主包组合仍已删除。如果你从 DSH `0.1.2-rc.1` 升级，请**新建会话**：Guard 不迁移旧日志、提案或证书，也不会删除或重新解释你的旧数据。

插件市场与 npm 安装现在统一发布按新到旧排列的精确并集 `0.1.5-rc.2 || 0.1.5-rc.1`。更早版本、未注册的稳定版 `0.1.5` 以及未来版本都不会被宣称为受支持。进入版本集合后仍必须匹配完整的 33 包 DSH 核心图；缺失、混装或未知图会 fail closed。

已注册的宿主组合是 **DSH `0.1.5-rc.1` 和 `0.1.5-rc.2`**，各自绑定完整的 33 个核心包。包身份取自已发布的 npm tarball；两个版本混装会被拒绝。注册表身份和原生验收是不同证据：原生通过需要匹配 Guard 制品、宿主版本和平台的验收附件。版本规则和宿主锁来源详见[兼容性说明](docs/COMPATIBILITY.md)。

重启属于单独能力。当前 DSH 没有提供可独立验证的 market 已加载实例绑定，因此 Guard 的 market 重启适配器返回不可用；已有重启要求仍保持未完成。核心保护和不依赖该接口的操作继续工作。磁盘上的插件安装/应用不等于运行进程或 UI 已生效。

升级到新核心锁时，需要从实际运行时与 profile 重新生成并验证锁；旧证书不会被重新标记为新锁证据。详见[升级说明](docs/HOST_LOCK_UPGRADE.md)和[兼容性](docs/COMPATIBILITY.md)。

从 [npm](https://www.npmjs.com/package/dsh-completion-guard) 选择已发布版本，并用 [GitHub Release](https://github.com/GreenLv/dsh-completion-guard/releases/latest) 的提交、校验和和原生 annex 核对制品。0.4.2 的历史发布面向 DSH `0.1.2-rc.1` 与 market 1.41；它不包含上述解耦。源码版本号、CI、同包原生验收和公开发布是不同状态，验收范围见[记录](docs/LOCAL_ACCEPTANCE.md)。

项目在 2026-08-29 从 `dsh-context-guard` 更名为 `dsh-completion-guard`，内部 bundle id 仍为 `context-guard`。迁移保留会话、激活方式和禁用设置；不要在同一 profile 同时加载新旧包。需要 Node.js `>=22` 和 pnpm `>=11`。

## 启用模式

Context Guard 有两种启用模式：

- `opt-in`（默认）：打开会话时不会自动保护。你需要在这个会话中执行 `/context-guard on` 才会启用；执行 `/context-guard off` 可以再次关闭。开关只影响当前会话。
- `always`：DSH 会话从第一条真实消息开始自动保护。全新会话保持完全空白——Guard 不写入任何内容——因此你仍然可以在发送任何内容之前选择 DSH 会话模式（standard、minimal 或自定义 preset）。第一条真实消息进入执行步骤的那一刻，保护在同一步骤内、且位于该消息之前开始：第一个任务连同它的第一次文件修改都在覆盖范围内。首条消息只有图片或附件时同样开始保护，并保留待解释的资产项；纯空白消息不启动任何内容。在某个会话中执行 `/context-guard off` 后，该会话关闭保护，直到再次执行 `on`。

启用模式只控制 Guard 是否保护会话，不是 DSH 的会话模式（例如会话开始时所选的标准模式、极简模式）。Guard 不再在第一条消息之前写入任何内容，因此 DSH 会话模式可以在会话尚为新会话时选择。`/context-guard on` 和 `/context-guard off` 只负责开启或关闭 Guard 保护，不会改变 DSH 会话模式。

如果希望 DSH 会话自动启用保护，请在当前 DSH 启动方式使用的 `cordis.patch.yml` 中增加：

```yaml
- id: context-guard
  name: dsh-completion-guard
  config:
    activation: always
```

DSH 有两种运行方式：**Web** 是在浏览器的网页界面里使用 DSH；**Headless** 是不打开网页界面，通常从终端或自动化任务运行 DSH。两种方式使用不同的配置文件。你用哪一种就修改哪一个；两种都用时需要分别修改：

| 系统 | 你怎么使用 DSH | 默认路径 |
| --- | --- | --- |
| macOS / Linux | Web | `$HOME/.dsh/profiles/web/cordis.patch.yml` |
| macOS / Linux | Headless | `$HOME/.dsh/profiles/headless/cordis.patch.yml` |
| Windows | Web | `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` |
| Windows | Headless | `%USERPROFILE%\.dsh\profiles\headless\cordis.patch.yml` |

如果你设置过自定义 `DSH_HOME`，请用该目录替换路径开头的 `$HOME/.dsh` 或 `%USERPROFILE%\.dsh`。

不想手动改文件，也可以把下面这段话直接发给 DSH：

> 请把 `dsh-completion-guard` 设为 `always` 模式。根据我当前使用 DSH 的方式（网页界面或无网页界面），自动找到对应的 `cordis.patch.yml`，先备份该文件，只把 `id: context-guard` 这一项的 `activation` 设为 `always`，不要修改其他配置，也不要替我重启 DSH。完成后告诉我文件的绝对路径，并显示准确的修改内容。

修改完成后，重启 DSH。

## 如何检查完成状态

启用后，Guard 会保存用户直接给出的要求和验收条件。只有已保存的工具结果与指定命令、文件或其他目标一致时，才能作为证据。取得机器完成认证需要通过 Guard 检查；证据缺失、过期或对象不一致时，任务保持未认证。当前证据规则未覆盖的调查或解释仍可如实回答并结束，但不会取得完成证书。

只读证据收集与修改包、文件、服务或 Git 状态的操作使用不同工具。查询成功不会自动产生变更权限。精确命令限制和平台证据见 [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md)。

### 要求一直未完成时

“更新插件并检查 GUI”可能包含 Guard 尚不能认证的部分；而“是否有更新”这类提问属于调查：Guard 会保留原文和来源，但如实说明无法机器认证——完成调查并如实回答即可。checkpoint 会逐项给出原因和一个具体的下一步；`context_guard_prepare`（只读）可以在执行有状态动作之前，展示受支持的命令形状、所需的 resolution/effect/state 证据顺序以及精确缺失的目标字段。

用 `context_guard_rebind` 提出完整的原文拆分方案。动作或对象不明确时，先请根用户给出包含原条款的明确澄清要求，再在提案中引用新要求的 ID。工具会返回提案 ID 和原项/替代项对照；用户把确认行 `确认重绑定 <proposal ID>` 作为回复的第一行即可应用，空行之后的解释请求或新任务保留各自含义，新任务照常采集。嵌在句子、引号或代码块里的确认，以及后面跟反转表述的确认，都无效。把要求拆成同样不可认证的片段会得到“无认证收益”，而不是要求一次无意义的确认。未支持的部分继续保留 pending；按结构化边界安全结束也不表示全部完成。

用 `bindings: []` 调用 `context_guard_checkpoint` 可查询诊断。默认最多展示八个当前要求/限制和十条证据，插件 JSON 不超过 12 KiB。`pagination` 给出总数及各列表独立的 `next_cursor`，首页不代表完整合同。`item_ids`、`evidence_ids` 可按 ID 查询；`evidence_scope: "history"` 可查看完整证据历史，其中不可引用项会明确标记。翻页时保持查询条件不变，合同或证据快照变化后需重新查询。超长行提供 `detail_id`，用 `detail_offset` 取分片；后续分片需把首次返回的 `snapshot` 作为 `detail_snapshot` 传回。分页只改变展示，不会减少认证时检查的要求。

## 0.6.3 为普通工作带来的变化

你会注意到四件事，以及最重要的那一件。

**疑问不会删掉旁边的指令，但同一子句内的混排不再自动授权。** 分开的子句各自保有自己的判读，因此“更新插件，检查是否存在更新，安装新主题，记录变更。”仍是一次更新、一个问句、一次安装、一次记录：回答只关闭问句，其余三项保持未完成。但当疑问、解释、调查与动作同处**一个子句**时，Guard 不再猜测该动作是独立指令，而是把整句保留为一条**未决**义务：它可见、不能被普通回答关闭、不能取得完成证书、不授予任何执行权限——想授权就把动作另写成一句（“确认缓存是否有效。然后安装依赖。”）。这是[合同修订说明](docs/CONTRACT_REVISION_0_6_3.md)记录的**有意收窄**：此前版本试图证明这类动作已经脱离疑问范围，而每一版证明都只是关于词表或词位的猜测。纯信息请求仍由收到的回答关闭。

**执行位置不再从会话启动目录推断。** 指令写明要改哪个仓库时，Guard 记录该选择及其来源；没有写明时，会话工作目录只作为上下文保留：未指明仓库的提交或推送保持为明确的待澄清问题，而不是按会话碰巧启动的目录放行。简短后续（“提交并推送”）只在当前工作单元中恰有一个用户已指定的仓库时继承它；出现两个候选时保持明确的选择留给用户；名为 `/repo-a.js` 的仓库仍是仓库——扩展名是你给的名字的一部分，不是它是何类文件的证据。

**`context_guard_prepare` 回答的是你真正问的那一项。** 它现在用执行门禁所用的同一判据，报告你打算执行的动作、修订与目标是否与当前义务一致。假设了不同动作时，它会说明并给出条目自身的动作，而不是给出一份门禁会拒绝的手册；动作手册标注为 `recipe_only`；你提供而义务并未选择的目标按“提议”报告，不作为授权。

**旧版本记录的义务不再被继承为通过。** 升级到 0.6.3 会重新检查仍会影响当前结论的记录（包括已标记 answered 的记录），凡自身文本仍包含执行要求、或其 Git 目标缺少可审计来源的，都标记为需要复核。历史按字节保留，不重放任何动作；但在你处理之前，它们会阻断新证书与 Goal 完成结论，使旧版本发布的误读不会悄然成为当前事实。

**守护程序不再要求你改写它无法认证的请求。** 当一个任务写明了本构建没有认证适配器的具体动作（例如清理目录、重命名、移除）时，Guard 报告这一能力限制，并让该工作保持未认证。它不再向你索要输入，也不再建议重绑定，因为这两者都不会改变能认证的范围。Guard 无法认证的工作仍然是你的工作，只是被如实报告为未认证。重绑定保持原义：用真实的根指令替换已记录义务，并且该指令必须写明受支持的动作与目标。

**工具调用成功不再被读成超出其本身的事实。** 每条 shell 结果现在分开表达：宿主返回了什么、控制台实际声明了什么退出状态、效果能否归属到本任务的操作、以及业务结果。如果没有读到退出状态，Guard 说 `unknown` 而不假定为 `0`；复合脚本最后一条命令成功，不构成前面命令也成功的证据。

**清理结果保留其适用条件。** “已删除”只对已证明无依赖的对象成立。恢复指引会陈述该条件、保持未知依赖可见，并分别报告注册信息移除、内容移除与目录移除，而不是把部分结果总结为完成。本版本不新增删除执行器、不杀进程，也不承诺阻止宿主无法观察的条件。

保持不变的部分：普通回答、调查与普通工具工作仍不需要 Guard 审批，Guard 也不会把自己的能力缺口说成你未授权。

## 0.6.1 为普通工作带来的变化

以下是你实际会注意到的行为。新协议边界之前的一切保持原有含义，不会被重新解释。

**提问不再留下永久待办。** 自动识别的疑问由宿主自身的记录关闭：正常完成 turn 的最后一条 assistant 消息。状态汇报、草稿、中间回复、其它 turn 的回答、子代理回答和被中断的 turn 都不会关闭它。"已交付"只说明回答到达了你，不说明它正确，也不说明有任何工作被执行。

无法判定的解释或混合请求需要通过 `context_guard_interpret` 显式划分信息与未知跨度。只有信息部分可由解释 turn 的回答关闭；未知和未申报部分保持 pending。Guard 校验结构与重放身份，语义划分的正确性仍由模型负责。

**附带的截图或图片是要回答的问题，不是要执行的命令。** 每个附件保留自己的身份，其关闭需要两个事实：显式的解释记录（实际读取附件后用 `context_guard_interpret` 传入 item ID）加上记录解释的 turn 的回答。一张包含提交按钮的图片不构成提交授权；声称"尚未查看图片"的回答什么也关不了。附图与真实修改分开关闭，明确要求的视觉验证仍需要自己的回读事实。

**文档"更新"由对象决定，而不是动词。** "更新文档"变成一次有界修改：具体文件由助手在你指令捕获到的目录与文件类型内决定。Guard 无法识别为文件的对象会保持诚实的"无法判定"状态，而不是被强行归为某个动作或被静默关闭。

**回答一个问题不等于完成整句话。** "检查是否有更新，顺便创建 report.txt"会在回答交付时关闭问题部分，而文件创建保持未完成，直到它有独立证据。

**任务按工作单元跟踪。** 把子任务委派给子代理会开启一个子单元，其未完成工作计入父单元，因此委派不会丢掉父任务自身的工作。子代理的回答记录为有界证据，绝不单独关闭父项。你此前声明的禁止项或等待，对后续任务中同一动作继续生效。

**澄清原子替换其修正对象。** 后续指令逐字包含某条未决义务时会原子替换它，并保留新旧 revision。解释、禁止和等待绝不因相似措辞删除义务，也不会因为新句子看起来相似就删除任何东西。

**宿主问答的可信回答会收窄目标。** 当助手询问文件放在哪里、你选择了某个目录，这个来自宿主问答工具、且 call 与 result 都在案的回答会收窄文件落点。粘贴进对话的文本不构成任何东西。沙箱审批单独记录，且从不用来授予目标。

## 策略档位

三个档位决定完成时需要多少证明。它们与 `opt-in` / `always` 激活方式相互独立，安装也绝不进入 release 档。

| 档位 | 要求 |
| --- | --- |
| `standard`（默认） | 工作必须有持久证据支撑；普通工具不会被额外的 Guard 审批拦在后面。 |
| `strict` | 在 standard 之上，你明确要求的视觉或完整范围验证必须由真实回读事实兑现，而不是一次"只是成功"的工具调用。 |
| `release` | 只有显式采用的发布契约才能授权发布操作。未采用之前，发布操作会被拒绝，而不是按 standard 规则执行。 |

在 `cordis.patch.yml` 的同一项里与 `activation` 一起设置：

```yaml
- id: context-guard
  name: dsh-completion-guard
  config:
    activation: always
    policy: strict
```

### 显式发布契约

发布绝不隐式发生。消息里的 "release" 关键词、加载的 Skill 或一次安装都不会采用任何东西；只有这条命令会：

```text
/context-guard release adopt {"operations":["npm_publish"],"candidate":{"ref":"refs/heads/main","fullSha40":"<40 位十六进制>","version":"0.6.1","artifactDigest":"<64 位十六进制>"}}
```

采用之后，`/context-guard release` 报告契约、候选、逐操作覆盖范围、已消费内容和仍在执行中的操作。每个操作只消耗一次预约记录：效果前写入，效果后依据可信回读结算。错候选 SHA、错 ref、错制品摘要或版本、过期票据、已消费票据、仍在执行中的请求重试和不透明 runner 都会在任何副作用之前被拒绝。

**覆盖面如实声明，并说明缺口归属。** 本版只保护 Guard 自己路由的表面：经 `context_guard_action` 发布 npm 制品。`git tag` 与 GitHub Release 各操作尚无 Guard 自有路由，因此要求它们的契约会在效果前被拒绝并报告为 `release_operation_unrouted`——这是本版明确采取的**范围缩减**，不是"宿主做不到"。复合 runner 作为不透明宿主边界被拒绝。`/context-guard release` 以机器可读形式打印该表。完全绕过 Guard 的可信进程内调用属于宿主信任边界；插件只报告它能看到的，不宣称能阻止它看不到的。

## 边界

Context Guard 负责完成认证；Goal、Todo、Compaction、continuation、权限和工具执行仍由 DSH 管理。它不是安全沙箱、语义证明系统、token pruning 工具，也不替代这些 DSH 能力。

证据采用有界存储和脱敏处理。Guard 不保存完整 prompt、stdout、文件内容、凭证、Authorization header、URL query value、图片字节或原始 transcript。详见 [`docs/PRIVACY.md`](docs/PRIVACY.md)。

## 与 Codex Context Guard 的关系

本项目最初从 [`GreenLv/codex-context-guard`](https://github.com/GreenLv/codex-context-guard) v0.8.8 移植确定性行为。这个版本只是历史起点，不代表当前兼容程度。

0.4.0 明确对齐了 Codex Context Guard 0.10.0 的共享证据规则：证据必须对应仍未完成的工作，并证明用户实际要求的操作、目标和结果。这只是有边界的行为对齐，不表示两个产品拥有相同功能。

0.6.x 实现了与本版配套的 Codex Context Guard 0.14.0 计划共享的 C01–C12 契约：来源跨度与覆盖、统一解释视图、可信回答交付、带必需后代闭包的工作单元、逐动作条件、责任分档、有界目标解析、原子澄清、证明能力矩阵、显式发布票据、新鲜投影和统一迁移诊断。逐条实现状态、通俗对照与注明日期的差异台账见 [`docs/SEMANTIC_COMPATIBILITY.md`](docs/SEMANTIC_COMPATIBILITY.md)。

有两项共享资产是刻意未完成的，写成已完成就是失实：上游仓库在本版发布时尚未落地冻结的 v2 一致性 fixture，因此这里的 v2 文件是 **DSH 产出的候选**而非字节镜像，`UPSTREAM_PIN.json` 仍只绑定未变的 v1 镜像。跨语言 parity 与正式镜像因此仍待完成，差异台账按此记录。

两个项目服务于不同运行时：

- `codex-context-guard` 是面向 Codex Hook 的 Python 实现，负责 Codex 插件缓存和 Hook 生命周期接入。
- `dsh-completion-guard` 是独立的 TypeScript 实现，基于 DSH 原生 Session 事件、命令、工具和 Agent 生命周期工作。

两个项目不共享运行时状态、安装器、缓存或发布历史。修复应先进入拥有对应运行时的仓库；只有同一行为确实适用于两侧时，才显式迁移。具体复用与替换边界见 [`docs/UPSTREAM_BASE.md`](docs/UPSTREAM_BASE.md) 和 [`docs/PORTING_NOTES.md`](docs/PORTING_NOTES.md)。

## npm 下载量历史

![dsh-context-guard 与 dsh-completion-guard 的 npm 累计下载增长](https://raw.githubusercontent.com/GreenLv/dsh-completion-guard/stats/npm-downloads.zh-CN.svg)

累计图分别显示更名前后的 npm 包下载总量，标记 2026-08-29 的更名，并仅在项目增长曲线中合并两者。npm 下载量统计的是 registry 请求，不等于独立用户数或已确认的真实安装人数。

历史从首次公开发布 npm 的 2026-08-26 开始，保留首日真实下载数，不强行归零；纵轴从零起算。日期标签统一居中，按固定天数间隔显示，图注始终保留精确截止日。

每日工作流仅发布至少相隔 12 小时复查一致、且距离当日已有两个 UTC 日历日的数据，另行标明 API 数据可用日期。这是项目的观测规则，不代表 npm 保证数值永不修订。详见[源数据](https://raw.githubusercontent.com/GreenLv/dsh-completion-guard/stats/npm-downloads.json)。

## 文档

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
pnpm run test:stats
pnpm run typecheck
pnpm test
pnpm run lint
pnpm run build
pnpm run pack:check
```

这些命令验证本地源码树与包。CI、原生平台验收、npm 发布、GitHub Release 身份和真实 DSH 环境安装仍是相互独立的证据范围。
