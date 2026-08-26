# dsh-context-guard

面向 DeepSeek Harness（DSH）的任务合同与完成认证层。

Context Guard 保存 requirements、prohibitions、acceptance criteria、后续修订和有界证据，只有当前合同对应的成功证据存在时才签发完成认证。

它不是 Goal、Todo、Memory、Compaction 替代品，也不是 token pruning 工具、安全沙箱或语义证明系统。

## 当前状态

0.1.0 已实现核心回路，并有 104 个测试（其中 domain/core 85 个）覆盖：带具体 subject/surface 的合同捕获、保守的命令 effect 解析、严格证据匹配、fail-closed 完成认证、重建时的证书重新验证、Goal 与回合停止门禁、恢复注入和持久化处理。macOS 与 Windows 的隔离真实模型验收均已确认：受支持的 shell 或 PowerShell 写入配合独立 read，可以在任务完成声明之前为匹配合同签发证书。

## 开发

```sh
pnpm install
pnpm test
pnpm run lint
pnpm run build
pnpm pack --dry-run --json
```

源码仓库已公开；npm 包与市场可用性仍需与源码及原生验收分别核验。
