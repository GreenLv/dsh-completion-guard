# Warm scope native acceptance

This supplement checks whether an installed Guard refuses a protected mock publish when a nearer package scope changes the current dependency route. It exercises Web and Headless separately in real DSH host processes without a model request. The runner accepts an already frozen Guard tgz; it does not pack or publish Guard.

The source checkout must be clean and match the full source commit embedded in the tgz. Supply the tgz's SHA-256, a physical official DSH runtime root, and the driver digest. The runner plans a new fixture within explicit file, byte, directory, link, and resolution budgets. It copies each physical file once and remaps internal links to their physical targets inside the fixture. It rejects unsafe or dangling links, cycles, changed bytes, and unavailable link capabilities before proceeding. The v2 copy inventory binds directories, file bytes, and remapped link topology; it does not establish runtime graph equivalence. Each profile's actual graph and host lock are checked after installation.

From the repository root, obtain the driver digest with:

```sh
python -c "import sys; from pathlib import Path; sys.path.insert(0, 'scripts'); import native_warm_scope_preflight as p; print(p.driver_digest(Path('scripts')))"
```

Calculate the digest on each host from its actual checkout bytes; line-ending conversion can produce different digests across checkouts.

Run `scripts/native_warm_acceptance.py` with `--repo-root`, `--runtime-root`, `--artifact`, `--artifact-sha256`, `--source-commit`, `--driver-sha256`, and an unused external `--output`. First add `--preflight`. Use a different unused output path when running without `--preflight`; an existing result is never overwritten. The default Web and Headless cohort is `dsh-0.2.2-rc.2-core-v1`; pass explicit `--web-cohort` and `--headless-cohort` to select another declared cohort.

The host's patch format cannot replace an entry's `name`. The runner therefore disables the installed Guard entry and inserts one wrapper. It checks the actual composed entries for one disabled original and one active wrapper. For the existing host-lock consumer only, it constructs a read-only view with the independently verified wrapper id and name replaced by the consumer's expected names; the wrapper's actual configuration lines are preserved. The wrapper imports the installed Guard and supplies only a local registry response, a counter-only publish effect, and an audit observer. It does not supply a fixed host lock.

Each profile warms an actual dependency resolution, performs a legitimate mock publish, and prepares a fresh unconsumed resolution for each redirect and deny vector. A separate child confirms the disk route. The registered Guard action must refuse without increasing the mock effect count, perform a fresh host-lock validation, and agree with an independent same-process production-graph drift readback. Once the scope is removed, the same resolution must succeed. These are synthetic release sessions and do not replay a private historical session.

A passing `dsh-native-warm-scope/v1` result requires both profiles, bound source/artifact/driver identities, positive and negative observations, and clean owned-process cleanup. The schema checks structure; the consumer checks ticket continuity, counts, audit progression, drift reasons, and subject identities. Validate a saved result with `scripts/native_warm_scope_validate.py`, the same source checkout, artifact, expected digests and `--expected-platform macos` or `--expected-platform windows`. Preflight refuses other native platforms. Its success does not replace the separate host-bound, Desktop, market, UI, credential, or real-model gates.

The runner writes redacted results and a stage sidecar outside the source checkout. A failed run or unknown child/process state retains its fixture and writes a local recovery sidecar; diagnose ownership and quiescence before disposal or another attempt. The recovery sidecar contains a local path and must remain private. A timeout or missing result is not a passing observation.

## 中文说明

此补充工具接收已冻结的 Guard tgz，分别在隔离的 Web 和 Headless 宿主中检查暖进程的近端 scope 漂移。先计算驱动摘要，使用 `--preflight` 和一个未使用的仓库外输出路径；正式执行时去掉该参数，并使用另一个未使用的输出路径。源码提交、tgz 摘要和驱动摘要必须与输入一致。

工具将官方 runtime 的每个实体文件复制一次，并把内部链接重映射到夹具内的目标；文件、字节、目录、链接数量和链接解析均有上限。外链、悬挂链接、循环、内容变化或所需链接能力缺失会使运行失败。v2 复制清单摘要绑定目录、文件内容和链接拓扑，不能据此认定运行时依赖图等价；安装后仍须核验每个 profile 的实际依赖图和宿主锁。原 runtime 与日常 profile 不会被写入。

工具禁用原 Guard 条目、插入唯一启用的 wrapper，再核验实际组合和 wrapper 的 host-lock 配置。发布效果由本地计数器模拟；registry 回复也由本地夹具提供。每个 profile 在同一暖进程中执行正控、redirect 与 deny 拒绝和相同 resolution 的恢复正控。执行记录使用合成会话，不代表历史私有会话重放。

完成后使用 `native_warm_scope_validate.py` 和相同源码、制品及摘要验证结果，并通过 `--expected-platform macos` 或 `--expected-platform windows` 明确接收平台；预检拒绝其他原生平台。失败或进程状态未知时保留 fixture，并在本地 recovery 文件中记录路径；确认进程归属和静止状态后再处理。该结果不能代替其他原生、Desktop、市场、界面、凭证或真实模型门禁。
