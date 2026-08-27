# 更新日志

本项目的重要变化记录在这里。项目仍处于 1.0 之前；版本号跟踪插件生命周期，不代表 API 已稳定。

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
