# dsh-context-guard

面向 DeepSeek Harness（DSH）的任务合同与完成认证层。

Context Guard 保存 requirements、prohibitions、acceptance criteria、后续修订和有界证据，只有当前合同对应的成功证据存在时才签发完成认证。

它不是 Goal、Todo、Memory、Compaction 替代品，也不是 token pruning 工具、安全沙箱或语义证明系统。

## 当前状态

项目仍处于早期开发阶段。当前实现以 DSH `0.1.1-rc.2` 为目标，核心回路已实现并有 41 个测试覆盖：合同捕获（始终带具体 subject/surface）、证据提取与严格匹配、fail-closed 完成认证（空证据绑定与无关证据都会被拒绝）、重建时的证书重新验证、Goal 完成门禁、回合停止门禁、恢复注入与持久化处理。插件可在真实 DSH headless 配置中加载；完整任务在真实 DSH Web profile 中的执行与 Windows 原生验收尚未验证。

## 开发

```sh
pnpm install
pnpm test
pnpm run lint
pnpm run build
pnpm pack --dry-run --json
```

本地开发不代表已执行远程发布或市场登记。
