# Dependency advisory gate / 依赖告警门禁

The repository runs a fail-closed dependency advisory gate (`scripts/audit_dependencies.py`,
required CI job `dependency-scan`). This page is the maintenance contract for that gate.

本仓库通过失败关闭的依赖告警门禁（`scripts/audit_dependencies.py`，必需 CI job
`dependency-scan`）检查依赖公告。本文是该门禁的维护说明。

## Policy / 策略

- Any `high` or `critical` advisory — production or development chain — fails the gate.
  A test-chain finding is still an unaccepted high/critical finding.
- `moderate` and `low` advisories are printed by the gate but do not block. They stay
  visible in CI logs; fixing them is encouraged, not gated.
- The scan must complete: a network failure, registry outage, or malformed `pnpm audit`
  output fails the gate (`exit 2`). A missing scan never reads as "zero vulnerabilities".

- 任何 `high`/`critical` 公告（无论生产链还是开发链）都会使门禁失败。
  开发链的 high/critical 同样是未接受的高危发现。
- `moderate`/`low` 公告会被打印但不阻断；修复值得鼓励，但不作为门禁条件。
- 扫描必须完成：网络失败、registry 不可用或 `pnpm audit` 输出不可解析时门禁失败
  （退出码 2）。扫描缺失绝不会被解读为“零漏洞”。

## Classification and reachability / 分类与可达性

`pnpm audit` reports scanner severity, not product severity. This package ships no
runtime dependencies beyond the audited DSH host cohort; advisories historically land in
the development chain (vitest/vite/tinypool/source-map-js and their transitive graphs).
Before acting on a finding, check where the module sits (`pnpm why <module>`) and whether
the advisory's precondition is reachable in this repository's usage — for example, the
tinypool advisories require attacker-controlled worker options, and the vitest mocker
advisories require untrusted mock inputs. Reachability decides priority; it never
converts a blocking advisory into a silent pass.

`pnpm audit` 报告的是扫描器严重性，不是产品严重性。本包除受审计的 DSH 宿主队列外
没有运行时依赖；历史告警均落在开发链（vitest/vite/tinypool/source-map-js 及其传递
依赖）。处理发现前先确认模块位置（`pnpm why <module>`）及其前置条件在本仓库用法中
是否可达——例如 tinypool 公告需要攻击者可控的 worker 选项，vitest mocker 公告需要
不可信的 mock 输入。可达性决定优先级，但绝不把阻断级公告变成静默通过。

## Fixing and upgrading / 修复与升级

1. Prefer a coordinated upgrade of the affected chain that stays inside the dependents'
   declared ranges (`pnpm update`, then `pnpm-workspace.yaml` `overrides` floors only when
   the fixed version is otherwise unreachable). Verify `pnpm install`, the full local
   matrix, and record the mapping advisory → version in the change log.
2. Never hide an incompatibility behind a blind force, and never delete lockfile entries
   to silence a scanner.
3. Dropping an override floor requires the dependents' own minimums to cover the fixed
   version.

1. 优先协调升级受影响链条，并保持在依赖方声明范围内（先 `pnpm update`；只有当修复
   版本无法通过范围解析时才在 `pnpm-workspace.yaml` 用 `overrides` 设下限）。验证
   `pnpm install` 与完整本地矩阵，并在变更日志记录“公告 → 版本”映射。
2. 不得用盲目 force 掩盖不兼容，也不得删除 lockfile 条目让扫描器闭嘴。
3. 只有当依赖方自身的最低版本覆盖修复版本后，才可移除 override 下限。

## Exceptions / 例外

Accepting a blocking advisory requires a matching entry in the machine-readable table
`scripts/dependency-scan-exceptions.json` (validated by the gate: expired, mismatched or
malformed entries leave the advisory blocking) plus the summary record below: advisory id,
affected module and version, why the advisory's precondition is unreachable here, the
owner, and an expiry date after which the exception must be re-justified or the chain
upgraded.

接受阻断级公告必须同时在机器可读表 `scripts/dependency-scan-exceptions.json` 登记
（由门禁校验：过期、不匹配或损坏的条目仍保持阻断）并在下表登记摘要：公告 ID、受影
响模块与版本、前置条件在本仓库不可达的原因、责任方、到期日；到期后必须重新论证或
完成升级。

| Advisory | Module@version | Severity | Rationale (summary) | Owner | Expires |
| --- | --- | --- | --- | --- | --- |
| GHSA-1243066 | zod@4.4.3 | high | Dev-chain only: exact-pinned transitive dep of the pinned `@deepseek-ai` 0.2.1-rc.2 host devDependencies (test replica). Nothing ships in the npm package; the advisory needs attacker-controlled oversized schema input, which offline deterministic tests never provide. Re-evaluate at the next host cohort bump (expected zod ≥4.6.6). | GreenLv | 2027-01-31 |
| GHSA-1243112 | undici@8.11.2 | high | Dev-chain only: exact-pinned transitive dep of `@deepseek-ai/dsh-http-proxy@0.2.1-rc.2` under the pinned host devDependencies. Nothing ships in the npm package; the advisory needs an attacker-controlled server sending crafted Content-Encoding stacks, which offline tests never contact. Re-evaluate at the next host cohort bump (expected undici ≥8.12.2). | GreenLv | 2027-01-31 |

## Recorded upgrades / 已记录的升级

The advisory state is whatever the gate prints for the lockfile under review; the
exception table above is the only durable record of accepted findings. Upgrades this
gate has already carried: the vitest 3.2.7 mocker path-traversal and tinypool 1.1.1
prototype-pollution/RCE chains were closed by moving to vitest 4.1.12 (which drops the
vulnerable tinypool 1.x pool) with `vite >=7.3.7 <8` and `source-map-js ^1.2.2` floors
inside the dependents' declared ranges. The vitest 4 migration seams for this repository
(manifest wrapper modules, the clean-startup test setup file, mock placement) are
described in the 0.11.0 change log.

门禁打印的告警状态始终针对被检查的 lockfile；上表是已接受发现的唯一持久记录。该
门禁已承载的升级：vitest 3.2.7 mocker 路径穿越与 tinypool 1.1.1 原型污染/RCE 链
通过迁移到 vitest 4.1.12（随之移除带漏洞的 tinypool 1.x pool）并设定
`vite >=7.3.7 <8`、`source-map-js ^1.2.2` 范围内下限关闭。本仓库 vitest 4 迁移的
接缝（manifest 包装模块、清空启动参数的测试 setup 文件、mock 摆放位置）见
0.11.0 变更日志。本仓库的 vitest 4 迁移注意事项（manifest 包装
模块、清空启动参数的测试 setup 文件、mock 摆放位置）见 0.11.0 变更日志。
