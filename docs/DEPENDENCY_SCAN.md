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

### Explicit temporary risk acceptance for 0.11.0 / 0.11.0 明确的临时风险接受

For the three Undici 8.11.2 findings added below, the maintainer explicitly accepted the disclosed residual risk and waived the ordinary unreachability eligibility requirement for this 0.11.0 validation. This is a specific exception to eligibility, not a finding that the whole host is unreachable or safe. The signed host remains unfixed, and a TLS 1.2 process-crash denial of service cannot be excluded. The cache and TLS-callback inspections narrow particular paths only; they do not establish whole-host isolation. Changing a development override would not repair signed-host bytes.

这次 0.11.0 验收新增的三条 Undici 8.11.2 例外，由维护者明确接受已披露的剩余风险，并对通常要求“前置条件不可达”的例外准入作一次特批。这不是“整个宿主不可达”或“已经安全”的结论。签名宿主仍未修复，TLS 1.2 导致进程崩溃的拒绝服务风险不能排除；cache 和 TLS callback 的静态检查只缩小部分路径，不能证明整个宿主隔离。修改开发依赖 override 也不会修复签名宿主中的代码。

Acceptance covers only scanner IDs 1243472, 1243474 and 1243477 with the exact advisory IDs and Undici version below. It expires on **2026-11-05 inclusive**, according to the runner's existing date semantics; from **2026-11-06**, the unchanged gate rejects the expired table and blocks again. Other findings, versions and release checks are not waived. The two older exceptions retain their original scope and expiry. Expiry blocks CI qualification and subsequent acceptance checks; it does not fix upstream code, disable an installed 0.11.0 instance, or withdraw a published package.

接受范围仅限 scanner ID 1243472、1243474、1243477 与下列精确公告 ID、Undici 版本的组合。有效期**包含 2026-11-05 当日**，沿用 runner 现有日期语义；自 **2026-11-06** 起，未改动的门禁会拒绝过期表并恢复阻断。其他发现、版本及发布检查不在豁免范围内；原有两条例外的范围和到期日保持不变。到期阻断的是 CI 资格和后续验收，不会自动修复上游、禁用已安装的 0.11.0 实例或撤回已发布的包。

The advisory id in the exception table is the scanner's numeric id; the GitHub
advisory it resolves to is recorded alongside it. Earlier drafts of this page
mistakenly wrote the numeric id as a GHSA code — the real identifiers are:

| Advisory (GitHub) | Scanner id | Module@version | Severity | Rationale (summary) | Owner | Expires |
| --- | --- | --- | --- | --- | --- | --- |
| [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) | 1243066 | zod@4.4.3 | high | Dev-chain only: exact-pinned transitive dep of the pinned `@deepseek-ai` host devDependencies (test replica of the audited cohort). Nothing ships in the npm package; the advisory needs attacker-controlled oversized schema input, which offline deterministic tests never provide. The verified rc.3 host manifests still exact-pin zod 4.4.3, so upgrading the host does not lift this. Re-evaluate at the next host cohort bump that carries zod ≥4.6.6. | GreenLv | 2027-01-31 |
| [GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c) | 1243112 | undici@8.11.2 | high | Dev-chain only: exact-pinned transitive dep of `@deepseek-ai/dsh-http-proxy` under the pinned host devDependencies. Nothing ships in the npm package; the advisory needs an attacker-controlled server sending crafted Content-Encoding stacks, which offline tests never contact. The verified rc.3 host manifests still exact-pin undici 8.11.2, so upgrading the host does not lift this. Re-evaluate at the next host cohort bump that carries undici ≥8.12.2. | GreenLv | 2027-01-31 |
| [GHSA-4w7w-5xrc-9h26](https://github.com/nodejs/undici/security/advisories/GHSA-4w7w-5xrc-9h26) | 1243472 | undici@8.11.2 | high | Explicit temporary risk acceptance: cache/redirect composition was not found in the inspected factory; whole-host/plugin configurations remain unknown. 明确临时接受 cache/redirect 剩余风险，不声称全宿主不可达。 | GreenLv | 2026-11-05 (inclusive) |
| [GHSA-2m5v-pch6-74hx](https://github.com/nodejs/undici/security/advisories/GHSA-2m5v-pch6-74hx) | 1243474 | undici@8.11.2 | high | Explicit temporary risk acceptance: application-specific TLS callbacks may be lost; the inspected factory lacks that callback, but other configurations are unknown. 明确临时接受 TLS callback 检查绕过风险，其他配置仍未知。 | GreenLv | 2026-11-05 (inclusive) |
| [GHSA-qrxm-fqhp-jwvm](https://github.com/nodejs/undici/security/advisories/GHSA-qrxm-fqhp-jwvm) | 1243477 | undici@8.11.2 | high | Explicit temporary risk acceptance: TLS 1.2 renegotiation can crash the client; reachability cannot be excluded and the signed host is unfixed. 明确临时接受可能可达的进程崩溃风险，签名宿主未修复。 | GreenLv | 2026-11-05 (inclusive) |

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

## Upstream references and follow-up / 上游参考与后续更新

- [DSH public dependency discussion](https://github.com/deepseek-ai/deepseek-harness/discussions/10847) records concerns about exact-pinned vulnerable dependencies. It does not establish that DSH maintainers have responded or scheduled a repair.
- [Undici 8.12.2 release](https://github.com/nodejs/undici/releases/tag/v8.12.2) lists the upstream fixes for these three advisories. That release does not replace code in an already signed DSH app. The reviewed rc.3, rc.4 and alpha.2 host manifests still pin Undici 8.11.2.

- [DSH 公开依赖讨论](https://github.com/deepseek-ai/deepseek-harness/discussions/10847)记录了精确锁定受影响依赖的担忧；不能据此声称 DSH 维护者已回应或已排期修复。
- [Undici 8.12.2 发布记录](https://github.com/nodejs/undici/releases/tag/v8.12.2)列出了这三条公告的上游修复，但该发布不会替换已有签名 DSH 应用内的代码。本次核对的 rc.3、rc.4 和 alpha.2 宿主 manifest 仍锁定 Undici 8.11.2。

Once an official compatible host carries the fixed dependency chain, recheck its actual signed/installed bytes and advisory result, validate the changed inputs, then update this disclosure and remove or reassess only the matching exceptions. Until then, the residual risk remains accepted only within the recorded scope and expiry; other acceptance gates stay in force.

后续官方兼容宿主带入修复链后，应重新核对实际签名及安装字节、公告扫描结果和受影响输入，再更新披露，并仅移除或重新评估相符的例外。在此之前，剩余风险只在已记录的范围和期限内被接受，其他验收门禁继续有效。
