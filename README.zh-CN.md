# dsh-completion-guard

[English](README.md)

面向 DeepSeek Harness（DSH）的任务保护插件。它保存任务要求，并在任务标记完成前逐项核对；会话恢复后仍使用同一份检查表，只有匹配的已保存工具结果才能作为证据。

![任务合同条款与有界证据通过 checkpoint 匹配后签发完成证书](assets/social/completion-guard-hero.png)

## 快速开始

以下步骤面向**尚未发布的 0.5.1 候选版本**。评估候选版本时，请使用随校验和与验收记录提供的冻结包：

```sh
dsh plugin --profile web add /absolute/path/to/dsh-completion-guard-0.5.1.tgz
```

0.5.1 发布后，再安装这个确切版本到 DSH 的 Web 运行环境：

```sh
dsh plugin --profile web add dsh-completion-guard@0.5.1
```

**请先升级并重启 DSH，再执行下面这一段。** `inject` 会记录运行目录与 profile 的绝对路径，并绑定它在当地读到的图；运行时之后会重新读取同一批根目录，因此在旧运行时上执行 inject 会写下一份描述"新运行时不复存在的那张图"的锁。`inject` 还会**把 Guard 的托管块写入 `<profile>/cordis.patch.yml`**，请先备份该文件。判定结果请读 JSON 输出里的 `status` 字段——**即使它是 `unsupported`，`inspect`、`inject`、`verify-dump` 的退出码仍是 `0`**，所以只看 `$?` 无法判断图是否被接受。

```sh
DSH_RUNTIME_ROOT=/absolute/path/to/.dsh-runtime
DSH_PROFILE_ROOT=/absolute/path/to/.dsh/profiles/web
GUARD_HOST_LOCK="$DSH_PROFILE_ROOT/node_modules/.bin/dsh-completion-guard-host-lock"

"$GUARD_HOST_LOCK" inspect --runtime-root "$DSH_RUNTIME_ROOT" --profile-root "$DSH_PROFILE_ROOT"
"$GUARD_HOST_LOCK" inject --runtime-root "$DSH_RUNTIME_ROOT" --profile-root "$DSH_PROFILE_ROOT"
dsh --profile web --dump-config | "$GUARD_HOST_LOCK" verify-dump --runtime-root "$DSH_RUNTIME_ROOT" --profile-root "$DSH_PROFILE_ROOT" --dump-config -
```

Windows 请通过 Web 配置目录下的 `node_modules\.bin\dsh-completion-guard-host-lock.cmd` 运行相同的三个子命令，并使用 Windows 绝对路径。**Windows 可接受判定，但本队列尚未经过原生审计**，因此原生门执行前应把 Windows 结果视为未验证。DSH、Guard 或 profile 路径变化后需要重新检查；仅 market 普通升级不需要重新注入。如果当前包集合缺失、混装、重复或不属于已检查环境，Guard 会保持不可用。

然后重启 DSH Web，打开会话并启用 Guard：

```text
/context-guard on
/context-guard status
```

默认采用 opt-in。`status` 显示 Guard 是否开启、启动阶段（`armed` 表示已就绪、等待你的第一条消息）以及还有多少检查项。`off` 停止保护当前会话，但不删除历史。`clear` 关闭当前待办，同时保留禁止项。`diagnose` 说明完成检查为什么通过或失败。

## 它保护什么

- 保存需求、验收条件、禁止项和后续修正，不覆盖旧记录。
- 只使用 DSH 已保存的工具调用和结果，并保存脱敏摘要而不是完整输出。
- 只有动作和结果对应指定命令、文件或其他目标时，证据才有效。
- 会话重建或恢复后重新检查完成状态；记录损坏时拒绝签发证书。
- 当前检查表尚未通过时，阻止 Guard 自己守卫的 Goal 完成路径。DSH 内部仍可能绕过这条路径，因此插件会报告这些情况，不声称能阻止所有写入。

## 状态与兼容性

0.5.1 支持 **DSH >= 0.1.5-rc.1**（配合 Cordis `4.0.2`），且不向后兼容：旧的 Session API、V2 事件词表和所有更早的宿主包组合都已删除，不再保留 fallback。`0.1.5-rc.1` 是本版本实际开发与验证的基线，不是支持上限。如果你从 DSH `0.1.2-rc.1` 升级，请**新建会话**：Guard 不迁移旧日志、提案或证书，也不会删除或重新解释你的旧数据。

版本范围与宿主校验是两层判断。范围 `>=0.1.5-rc.1` 会拒绝更早的版本，包括 `0.1.4` 与 `0.1.5-alpha.9`；而某个已安装宿主是否真正可用，由精确的 33 包 DSH 核心图决定：未注册的图会被报告为未验证，绝不报告为受支持。alpha 与更早 RC 的包组合只作为历史身份保留，由这些组合构成的运行环境会被报告为不受支持，而不会通过认证。

已注册的宿主组合是 **DSH `0.1.5-rc.1` 和 `0.1.5-rc.2`**，各自绑定完整的 33 个核心包。包身份取自已发布的 npm tarball；两个版本混装会被拒绝。注册表身份和原生验收是不同证据：原生通过需要匹配 Guard 制品、宿主版本和平台的验收附件。版本规则和宿主锁来源详见[兼容性说明](docs/COMPATIBILITY.md)。

重启属于单独能力。当前 DSH 没有提供可独立验证的 market 已加载实例绑定，因此 Guard 的 market 重启适配器返回不可用；已有重启要求仍保持未完成。核心保护和不依赖该接口的操作继续工作。磁盘上的插件安装/应用不等于运行进程或 UI 已生效。

升级到新核心锁时，需要从实际运行时与 profile 重新生成并验证锁；旧证书不会被重新标记为新锁证据。详见[升级说明](docs/HOST_LOCK_UPGRADE.md)和[兼容性](docs/COMPATIBILITY.md)。

从 [npm](https://www.npmjs.com/package/dsh-completion-guard) 选择已发布版本，并用 [GitHub Release](https://github.com/GreenLv/dsh-completion-guard/releases/latest) 的提交、校验和和原生 annex 核对制品。0.4.2 的历史发布面向 rc.1 与 market 1.41；它不包含上述解耦。源码版本号、CI、同包原生验收和公开发布是不同状态，验收范围见[记录](docs/LOCAL_ACCEPTANCE.md)。

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

## 边界

Context Guard 负责完成认证；Goal、Todo、Compaction、continuation、权限和工具执行仍由 DSH 管理。它不是安全沙箱、语义证明系统、token pruning 工具，也不替代这些 DSH 能力。

证据采用有界存储和脱敏处理。Guard 不保存完整 prompt、stdout、文件内容、凭证、Authorization header、URL query value、图片字节或原始 transcript。详见 [`docs/PRIVACY.md`](docs/PRIVACY.md)。

## 与 Codex Context Guard 的关系

本项目最初从 [`GreenLv/codex-context-guard`](https://github.com/GreenLv/codex-context-guard) v0.8.8 移植确定性行为。这个版本只是历史起点，不代表当前兼容程度。

0.4.0 明确对齐了 Codex Context Guard 0.10.0 的共享证据规则：证据必须对应仍未完成的工作，并证明用户实际要求的操作、目标和结果。这只是有边界的行为对齐，不表示两个产品拥有相同功能。

Codex Context Guard 0.11.0 在此后发布。DSH 0.4.0 已经能按自己的宿主机制核对精确变更目标、等待状态和引用文字，但还没有完整同步 0.11.0 的一次性授权票据、工作单元、需求替代归因和事故 benchmark。通俗对照表与注明日期的差异台账见 [`docs/SEMANTIC_COMPATIBILITY.md`](docs/SEMANTIC_COMPATIBILITY.md)。

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
