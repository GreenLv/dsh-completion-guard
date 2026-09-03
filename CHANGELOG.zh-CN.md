# 更新日志

本项目的重要变化记录在这里。项目仍处于 1.0 之前；版本号跟踪插件生命周期，不代表 API 已稳定。

## 0.4.1-rc.1 - 未发布的本地候选

- 新增经过原生 macOS 审计的 DSH `0.1.2-rc.1` + dshmarket `1.41.0` 精确宿主队列；Windows 在取得独立原生证据前继续失败关闭。
- 通过 rc.1 的 `snapshotEvents()` API 读取会话历史，同时保留此前已审计 DSH 队列使用的旧版 `events` 路径。
- 发布状态保持独立：该开发候选只用于隔离环境和日用 profile 验收，不表示已经发布到 npm 或 GitHub Release。

## 0.4.0 - 2026-09-02

### 新增

- **DSH alpha.3 成为 0.4.0 的实现基线。** 0.4.0 面向 DSH `0.1.2-alpha.3`、dshmarket `1.39.0` 和 Cordis `4.0.2`。
- **证据必须证明用户实际要求、而且仍未完成的工作。** 读取或检查另一个目标不能关闭当前事项；来自其他会话、动作或目标不匹配、没有显示所需结果的证据都会被拒绝。
- **变化或损坏的证明记录不能继续复用。** 一旦已记录文件、任务范围或保存状态不再匹配，证明就会失效，工作继续保持未完成。Guard 只保留完成核对所需的有限事实，不保存原始私有日志或文件内容。
- **阶段处置记录。** 已停止的 0.3.3 兼容候选明确记为 `superseded_before_candidate`；该阶段不存在 0.3.3 源码、工件、安装、原生验收、提交、tag 或 release。

### 变更

- **alpha.3 之后暂停兼容性适配。** 0.4.0 继续冻结在 DSH alpha.3 环境。alpha.4 及此后的 alpha 版本不作为新的适配目标；上游发布 alpha.3 之后的第一版 RC 时再恢复适配。上游版本进度见 [DeepSeek Harness 标签页](https://github.com/deepseek-ai/deepseek-harness/tags)。

### 验证

- 发布提交通过仓库矩阵，以及 Ubuntu、macOS、Windows 上的 Node.js 22/24 CI。同一份 26 文件 tgz 用于 macOS、Windows 原生验收和 npm 发布；GitHub Release 附带校验和与平台验收记录。
- 更早的 0.4.0 候选包只保留为历史证据。包字节变化后，旧结果不会迁移到新包；详见 [`docs/LOCAL_ACCEPTANCE.md`](docs/LOCAL_ACCEPTANCE.md)。

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
