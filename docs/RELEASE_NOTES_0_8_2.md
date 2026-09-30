# DSH Completion Guard 0.8.2

## English

This release adapts Guard to DSH RC.2 and adds an independent host lock for the official Desktop app. It keeps the 0.8.x task, certificate and data protocols. It also fixes shell evidence that could mistake an obscured failure marker for success.

Upgrade DSH to `0.2.0-rc.2` or later before installing Guard. Keep the host stopped while installing, inspecting and injecting the new lock, and verifying the composed configuration. Each profile needs its own lock; existing certificates retain their historical identity. Follow the [upgrade guide](HOST_LOCK_UPGRADE.md).

For Desktop, use the CLI shipped with the application to install plugins. Guard checks the vendor-signed carrier, archive bytes and actual dependency routes. Its `dump-desktop` command composes configuration through the bundled APIs without starting a host. The graphical app owns its restart lifecycle.

The reviewed baseline is DSH `0.2.0-rc.2` with Cordis `4.0.4`. Later versions require implementation qualification. Source checks, portability CI, same-artifact native backend acceptance, GUI/model observations and public publication identity have separate evidence. Use the Release attachments for the exact commit, package checksum and platform scope; see [compatibility](COMPATIBILITY.md) and [acceptance](LOCAL_ACCEPTANCE.md).

## 简体中文

本版本适配 DSH RC.2，并为官方 Desktop 应用新增独立宿主锁；任务、证书与数据协议延续 0.8.x。同时修复 shell 失败退出标记被后续文字遮挡时可能误报成功的问题。

请先将 DSH 升级到 `0.2.0-rc.2` 或更高版本，再安装 Guard。安装、检查、注入新锁及回读组合配置期间保持宿主停止；每个 profile 分别建立锁，旧证书保留历史身份。具体步骤见[升级指南](HOST_LOCK_UPGRADE.md)。

Desktop 插件须通过应用附带的 CLI 安装。Guard 核验厂商签名载体、归档字节与实际依赖路由；`dump-desktop` 通过应用内 API 组合配置，不启动宿主。图形应用的重启仍由应用自行管理。

已审查基线是 DSH `0.2.0-rc.2`、Cordis `4.0.4`；较新版本仍须通过实现资格验证。源码检查、跨平台 CI、同包原生后端、GUI/模型观察与公开发布身份分别建立证据。请用 Release 附件核对精确提交、包摘要和平台范围；详见[兼容性](COMPATIBILITY.md)及[验收记录](LOCAL_ACCEPTANCE.md)。
