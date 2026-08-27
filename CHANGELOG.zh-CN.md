# 更新日志

本项目的重要变化记录在这里。项目仍处于 1.0 之前；版本号跟踪插件生命周期，不代表 API 已稳定。

## 0.2.0 - Unreleased

### 新增

- **以会话 cwd 为基准的 subject 解析（F1）。** 证据 artifact subject 优先按调用 `workdir` 解析；当 shell 工具不携带 workdir（macOS 的 persistent bash/pwsh 工具仅暴露 `command`）时，缺省使用会话 scope cwd。相对路径的 `read`/`write`/`edit`/shell subject 现在能与同一 cwd 派生的契约 subject 匹配，白名单可执行文件的无路径 `run` 也会归因到该 cwd。这消除了 macOS 上 scope 契约永远无法满足的死点，且不降低任何 fail-closed 边界。
- **可认证命令面扩展（F2）。** POSIX shell 接受 `N>&M` 诊断流复制（`2>&1`）；PowerShell 中未加引号的 `N>&M` 会被剥离；POSIX 侧新增只读检查工具（`grep`、`rg`、`head`、`tail`、`wc`、无 in-place 标志的 `sed`）并产生 read 效果；PowerShell 接受白名单外部可执行文件（`git`、`pnpm`、`npm`、`node`、`python`、`tsc`、`vitest`、`pytest` 等，与 POSIX run 白名单一致）且参数必须全为字面值。复合语法、文件目标 fd 重定向、in-place `sed`、变量和非白名单可执行文件仍然 fail-closed。
- **过程动词的契约映射（F3）。** 任务级动作——拉取/获取/同步/更新/下载/安装/部署/上传/提交/推送/发布/升级，以及 `pull`/`fetch`/`clone`/`sync`/`update`/`install`/`deploy`/`commit`/`push`/`release`/`download`/`upload`——现在把捕获到的条款映射为 `run` 操作，因此 scope 内一次成功的执行即可封闭它们（此前无操作动词的条款默认走状态验证判定面，无法由工作证据本身封闭）。

### 变更

- `parseShellCommand`/`parsePwshCommand` 保持同一条 fail-closed 原则：无法完整识别的命令仍然产出空的 executables 与 operations。

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
