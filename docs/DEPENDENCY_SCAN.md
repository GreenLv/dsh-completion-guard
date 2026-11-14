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

`pnpm audit` reports scanner severity, not product severity. Some findings came from the development chain, including vitest and its dependencies. Others also affect the packages shipped with DSH, as described below.
Before acting on a finding, check where the module sits (`pnpm why <module>`) and whether
the advisory's precondition is reachable in this repository's usage — for example, the
tinypool advisories require attacker-controlled worker options, and the vitest mocker
advisories require untrusted mock inputs. Reachability decides priority; it never
converts a blocking advisory into a silent pass.

`pnpm audit` 报告的是扫描器严重性，不是产品严重性。有些公告来自 vitest 等开发依赖，有些也影响 DSH 自带的包，见下文。处理发现前先确认模块位置（`pnpm why <module>`）及其前置条件在本仓库用法中
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

### Historical temporary risk acceptance for 0.11.0 / 0.11.0 历史临时风险接受

For the three Undici 8.11.2 findings added below, the maintainer explicitly accepted the disclosed residual risk and waived the ordinary unreachability eligibility requirement for this 0.11.0 validation. This is a specific exception to eligibility, not a finding that the whole host is unreachable or safe. The signed host remains unfixed, and a TLS 1.2 process-crash denial of service cannot be excluded. The cache and TLS-callback inspections narrow particular paths only; they do not establish whole-host isolation. Changing a development override would not repair signed-host bytes.

这次 0.11.0 验收新增的三条 Undici 8.11.2 例外，由维护者明确接受已披露的剩余风险，并对通常要求“前置条件不可达”的例外准入作一次特批。这不是“整个宿主不可达”或“已经安全”的结论。签名宿主仍未修复，TLS 1.2 导致进程崩溃的拒绝服务风险不能排除；cache 和 TLS callback 的静态检查只缩小部分路径，不能证明整个宿主隔离。修改开发依赖 override 也不会修复签名宿主中的代码。

The original 0.11.0 acceptance covered only scanner IDs 1243472, 1243474 and 1243477 with the exact advisory IDs and Undici version below. Its expiry was **2026-11-05 inclusive**: the exception table shipped in that release would block from **2026-11-06** if left unchanged. The later 0.12.0 decision and expiry are recorded below. Other findings, versions and release checks are not waived. The two older exceptions retain their original scope and expiry. Expiry blocks CI qualification and subsequent acceptance checks; it does not fix upstream code, disable an installed 0.11.0 instance, or withdraw a published package.

原 0.11.0 接受范围仅限 scanner ID 1243472、1243474、1243477 与下列精确公告 ID、Undici 版本的组合。原有效期**包含 2026-11-05 当日**；该发布所带的例外表若保持不变，将从 **2026-11-06** 起恢复阻断。下节单独登记本次 0.12.0 的新授权和期限。其他发现、版本及发布检查不在豁免范围内；原有两条例外的范围和到期日保持不变。到期阻断的是 CI 资格和后续验收，不会自动修复上游、禁用已安装的 0.11.0 实例或撤回已发布的包。

The advisory id in the exception table is the scanner's numeric id; the GitHub
advisory it resolves to is recorded alongside it. Earlier drafts of this page
mistakenly wrote the numeric id as a GHSA code — the real identifiers are:

| Advisory (GitHub) | Scanner id | Module@version | Severity | Rationale (summary) | Owner | Expires |
| --- | --- | --- | --- | --- | --- | --- |
| [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) | 1243066 | zod@4.4.3 | high | Dev-chain only: exact-pinned transitive dep of the pinned `@deepseek-ai` host devDependencies (test replica of the audited cohort). Nothing ships in the npm package; the advisory needs attacker-controlled oversized schema input, which offline deterministic tests never provide. The verified rc.3 and rc.5 host manifests still exact-pin zod 4.4.3, so upgrading the host does not lift this. Re-evaluate at the next host cohort bump that carries zod ≥4.6.6. | GreenLv | 2027-01-31 |
| [GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c) | 1243112 | undici@8.11.2 | high | Dev-chain only: exact-pinned transitive dep of `@deepseek-ai/dsh-http-proxy` under the pinned host devDependencies. Nothing ships in the npm package; the advisory needs an attacker-controlled server sending crafted Content-Encoding stacks, which offline tests never contact. The verified rc.3 and rc.5 host manifests still exact-pin undici 8.11.2, so upgrading the host does not lift this. Re-evaluate at the next host cohort bump that carries undici ≥8.12.2. | GreenLv | 2027-01-31 |
| [GHSA-4w7w-5xrc-9h26](https://github.com/nodejs/undici/security/advisories/GHSA-4w7w-5xrc-9h26) | 1243472 | undici@8.11.2 | high | Explicit temporary risk acceptance, 0.11.0 validation ONLY: cache/redirect composition was not found in the inspected factory; whole-host/plugin configurations remain unknown. 明确临时接受 cache/redirect 剩余风险，仅限 0.11.0 验收，不声称全宿主不可达。 | GreenLv | 2026-11-05 (inclusive) |
| [GHSA-2m5v-pch6-74hx](https://github.com/nodejs/undici/security/advisories/GHSA-2m5v-pch6-74hx) | 1243474 | undici@8.11.2 | high | Explicit temporary risk acceptance, 0.11.0 validation ONLY: application-specific TLS callbacks may be lost; the inspected factory lacks that callback, but other configurations are unknown. 明确临时接受 TLS callback 检查绕过风险，仅限 0.11.0 验收，其他配置仍未知。 | GreenLv | 2026-11-05 (inclusive) |
| [GHSA-qrxm-fqhp-jwvm](https://github.com/nodejs/undici/security/advisories/GHSA-qrxm-fqhp-jwvm) | 1243477 | undici@8.11.2 | high | Explicit temporary risk acceptance, 0.11.0 validation ONLY: TLS 1.2 renegotiation can crash the client; reachability cannot be excluded and the signed host is unfixed. 明确临时接受可能可达的进程崩溃风险，仅限 0.11.0 验收，签名宿主未修复。 | GreenLv | 2026-11-05 (inclusive) |

### 0.12.1 patch release / 0.12.1 修复版

The registry audit still reports the same three high-severity Undici 8.11.2 advisories. The signed rc.5 host and the upstream default branch still pin the affected version. The maintainer separately accepted those three findings for Guard 0.12.1 through **2026-11-30 inclusive**. At the time, the exception table covered Guard 0.12.0 and 0.12.1. The later decision for 0.13.0 appears below.

本次 registry 扫描仍检出相同三条 Undici 8.11.2 高危通告。签名 rc.5 宿主和上游默认分支仍锁定受影响版本。维护者单独接受本次 Guard 0.12.1 的三项风险，截止 **2026-11-30（含）**。当时的例外表覆盖 Guard 0.12.0 和 0.12.1。0.13.0 的后续决定见下文。

### 0.13.2 development candidate / 0.13.2 开发候选

The 0.2.2-rc.3 host cohort bump re-ran the scan against the rc.3 registry graph (devDependencies pinned at rc.3): `undici@8.11.2` remains exact-pinned via `@deepseek-ai/dsh-http-proxy`, so the SAME THREE recorded Undici advisories still report (scanner IDs 1243472, 1243474, 1243477). The dev-chain zod advisory entry no longer fires: the rc.3 dev graph resolves `zod@4.6.6`, outside the accepted `zod@4.4.3` scope, and that accept has not been widened. The rc.3 graph also resolves `fast-uri@3.1.8` with two `moderate` and one `low` findings plus further `moderate` Undici findings — non-blocking severities that stay visible in the gate log; no accept is recorded for them. **On 2026-11-15 the maintainer authorized the same three Undici 8.11.2 exceptions for Guard 0.13.2 only, through 2026-11-30 inclusive.** The machine-readable entries retain their exact advisory identities, package version and expiry; all other risks remain outside this decision. The signed-host bytes remain unfixed; a development override does not repair them.

0.2.2-rc.3 宿主队列升级对 rc.3 registry 图（开发依赖锁定 rc.3）重跑了扫描：`undici@8.11.2` 仍经 `@deepseek-ai/dsh-http-proxy` 精确锁定，既有的同三条 Undici 通告继续报告（scanner ID 1243472、1243474、1243477）。开发链 zod 通告不再触发：rc.3 开发图解析为 `zod@4.6.6`，不在已接受的 `zod@4.4.3` 范围内，该接受也未扩大。rc.3 图还解析出 `fast-uri@3.1.8`（两条 `moderate`、一条 `low`）及若干 Undici `moderate` 发现——均为非阻断级别，仅保留在门禁日志中，未登记任何接受。**维护者于 2026-11-15 授权将同三项 Undici 8.11.2 例外仅扩展至 Guard 0.13.2，有效期仍截至 2026-11-30（含）。** 机器可读条目保留精确公告、包版本和截止日；其他风险不在此次决定范围内。签名宿主字节仍未修复，开发 override 不修复它们。

### 0.13.1 development candidate / 0.13.1 开发候选

The 0.2.2-rc.2 host cohort bump re-ran the scan against the rc.2 registry graph: the host packages now declare `zod@4.6.6` (the dev-chain zod@4.4.3 accept no longer applies to this graph), while `undici@8.11.2` remains exact-pinned via `@deepseek-ai/dsh-http-proxy`, so the recorded Undici advisories still report. On **2026-11-13** the maintainer directly authorized the SAME THREE temporary Undici accepts (scanner IDs 1243472, 1243474, 1243477 with their recorded GHSA identities) for Guard 0.13.1, **with the expiry unchanged: 2026-11-30 inclusive**. The machine-readable exception table now lists Guard 0.12.0, 0.12.1, 0.13.0 and 0.13.1 for exactly those three entries; no other risk is accepted and no date is extended. The signed-host bytes remain unfixed; a development override does not repair them. From **2026-12-01** the three entries block again unless re-justified. New Guard regressions, new unaccepted advisories, identity gates, required historical source regressions and network/parse failures stay blocking.

0.13.1 候选对 rc.2 registry 图重跑了扫描：宿主包现在声明 `zod@4.6.6`（原先针对 zod@4.4.3 的接受不再适用），`undici@8.11.2` 仍经 `@deepseek-ai/dsh-http-proxy` 精确锁定，相关 Undici 通告继续报告。维护者于 **2026-11-13** 直接授权：既有三条临时 Undici 接受（scanner ID 1243472、1243474、1243477 及其登记的 GHSA 身份）加入 Guard 0.13.1，**期限不变：2026-11-30（含）**。机器可读例外表在这三个条目上列入 0.12.0、0.12.1、0.13.0 与 0.13.1；不接受其他风险，不延长日期。签名宿主字节仍未修复，开发 override 不修复它们。自 **2026-12-01** 起三条目恢复阻断，除非重新论证。Guard 新增回归、未接受的新通告、身份门、必需的历史库源码回归及网络/解析失败仍按现行门禁阻断。

### 0.13.0 development candidate / 0.13.0 开发候选

The 0.2.2-rc.1 host cohort bump does not lift any gap: the target registry manifests still exact-pin `undici@8.11.2` (via `@deepseek-ai/dsh-http-proxy`) and `zod@4.4.3` (via `@deepseek-ai/dsh-agent` and `@deepseek-ai/dsh-commands`). On **2026-11-06** the maintainer decided that the already disclosed upstream gaps remain non-blocking for this release and extended the three existing temporary Undici accepts (scanner IDs 1243472, 1243474, 1243477 with their recorded GHSA identities) to the 0.13.0 candidate **with the expiry unchanged: 2026-11-30 inclusive**. The machine-readable exception table now lists Guard 0.12.0, 0.12.1 and 0.13.0 for those three entries only; the zod entry and the other long-term Undici entry keep their existing **2027-01-31** scope unchanged. No new advisory is accepted, no expiry is extended, signed-host bytes remain unfixed, and a development override does not repair them. From **2026-12-01** the three entries block again unless re-justified. New Guard regressions, new unaccepted advisories, identity gates, required historical source regressions and network/parse failures stay blocking.

0.2.2-rc.1 宿主队列升级未关闭任何缺口：目标 registry manifest 仍精确锁定 `undici@8.11.2`（经 `@deepseek-ai/dsh-http-proxy`）与 `zod@4.4.3`（经 `@deepseek-ai/dsh-agent` 与 `@deepseek-ai/dsh-commands`）。维护者于 **2026-11-06** 决定：已披露的上游缺口继续不阻塞本次发版，并将既有三条临时 Undici 接受（scanner ID 1243472、1243474、1243477 及其登记的 GHSA 身份）扩展到 0.13.0 候选，**期限不变：2026-11-30（含）**。机器可读例外表仅在这三条目上列入 Guard 0.12.0、0.12.1 与 0.13.0；zod 条目与另一条长期 Undici 例外保持原 **2027-01-31** 范围不变。未接受任何新通告，未延长任何期限，签名宿主字节未修复，开发 override 不修复它们。自 **2026-12-01** 起三条目恢复阻断，除非重新论证。Guard 新增回归、未接受的新通告、身份门、必需的历史库源码回归及网络/解析失败仍按现行门禁阻断。

### 0.12.0 release history / 0.12.0 发布历史

The reviewed rc.3 host also pins the same Undici and zod versions, so retaining rc.3 admission does not close the disclosed gaps.

The rc.5 cohort bump does not change this picture. The verified `0.2.1-rc.5` registry manifests and the regenerated 0.12.0 lockfile still exact-pin `undici` 8.11.2 (via `@deepseek-ai/dsh-http-proxy`) and `zod` 4.4.3 (via `@deepseek-ai/dsh-commands`), and the upstream default branch still pins the same Undici, so no gap is closed by adopting rc.5. On 2026-11-02 the maintainer explicitly and separately accepted the same three exact Undici 8.11.2 findings for 0.12.0 validation, including the disclosed residual risk and ordinary-unreachability eligibility waiver, and extended their expiry to **2026-11-30 inclusive**. Only scanner IDs 1243472, 1243474 and 1243477 with their recorded GHSA identities are covered. From **2026-12-01** the gate blocks them again unless re-justified. The signed host remains unfixed; whole-host unreachability is not established and the TLS 1.2 process-crash risk cannot be excluded. The table above preserves the first 0.11.0 authorization; the current table below and machine-readable rationales record the separately authorized 0.12.0 scope. Other findings, versions and release gates are not waived. Expiry affects later qualification; it does not automatically disable an installed instance or withdraw a published package. The two older exceptions remain within their original scope and expiry, with their rationale updated to reference the rc.5 cohort.

已审查的 rc.3 宿主也锁定相同版本的 Undici 和 zod，因此保留 rc.3 准入不会关闭已披露缺口。

rc.5 队列升级不改变上述结论：已核验的 `0.2.1-rc.5` registry manifest 与再生的 0.12.0 lockfile 仍精确锁定 `undici` 8.11.2（经 `@deepseek-ai/dsh-http-proxy`）与 `zod` 4.4.3（经 `@deepseek-ai/dsh-commands`），上游默认分支同样保留旧 Undici，因此本版没有关闭任何缺口。维护者于 2026-11-02 明确、单独接受本次 0.12.0 验收中相同三条 Undici 8.11.2 发现的已披露剩余风险，并特批通常要求前置条件不可达的例外资格，期限延至 **2026-11-30（含）**。仅覆盖 scanner ID 1243472、1243474、1243477 及其已登记 GHSA 身份。自 **2026-12-01** 起，未经重新论证的例外恢复阻断。签名宿主未修复，不能证明整个宿主不可达，也不能排除 TLS 1.2 进程崩溃风险。上表保留首次 0.11.0 授权历史，下表及机器可读 rationale 记录单独授权的当前 0.12.0 范围；其他发现、版本和发布核验不在豁免范围内。到期影响后续资格核验，不会自动禁用已安装实例或撤回已发布的包。原有两条例外保持原范围与到期日，仅将依据更新为 rc.5 队列口径。

| Advisory accepted for 0.12.0 / 0.12.0 接受的公告 | Scanner id | Module@version | Owner | Expires (inclusive) |
| --- | --- | --- | --- | --- |
| GHSA-4w7w-5xrc-9h26 | 1243472 | undici@8.11.2 | GreenLv | 2026-11-30 |
| GHSA-2m5v-pch6-74hx | 1243474 | undici@8.11.2 | GreenLv | 2026-11-30 |
| GHSA-qrxm-fqhp-jwvm | 1243477 | undici@8.11.2 | GreenLv | 2026-11-30 |

`pnpm audit` on the 0.12.0 lockfile additionally reports four moderate Undici findings (scanner IDs 1243077, 1243080, 1243480, 1243483 — EventSource unbounded memory, SRI token case bypass, WebSocket PONG buffering, decompress-interceptor exception) and four `fast-uri` moderate/low findings (1243098, 1243104, 1243101, 1243107) in the development chain. Per the policy above these are printed, non-blocking, and recorded here; they are additional signals on the same unfixed host pin, not evidence that the risk shrank.

0.12.0 lockfile 的 `pnpm audit` 另报告四条 moderate Undici 公告（scanner ID 1243077、1243080、1243480、1243483）与四条 `fast-uri` moderate/low 公告（1243098、1243104、1243101、1243107），均在开发链。按上述策略它们仅打印、不阻断，并在此记录；它们是同一未修复宿主 pin 上的新增信号，不代表风险下降。

## Recorded upgrades / 已记录的升级

The advisory state is whatever the gate prints for the lockfile under review; the
gate applies the scope and expiry in `scripts/dependency-scan-exceptions.json`. The tables above record the version-specific decisions. Upgrades this
gate has already carried: the vitest 3.2.7 mocker path-traversal and tinypool 1.1.1
prototype-pollution/RCE chains were closed by moving to vitest 4.1.12 (which drops the
vulnerable tinypool 1.x pool) with `vite >=7.3.7 <8` and `source-map-js ^1.2.2` floors
inside the dependents' declared ranges. The vitest 4 migration seams for this repository
(manifest wrapper modules, the clean-startup test setup file, mock placement) are
described in the [original 0.11.0 changelog entry](https://github.com/GreenLv/dsh-completion-guard/blob/650a952a7d44d4be2b9019dadc2f11e5104ff06e/CHANGELOG.md#0110).

门禁按被检查的 lockfile 报告公告，并以 `scripts/dependency-scan-exceptions.json` 的范围和期限为准。上表保留各版本的决定。该
门禁已承载的升级：vitest 3.2.7 mocker 路径穿越与 tinypool 1.1.1 原型污染/RCE 链
通过迁移到 vitest 4.1.12（随之移除带漏洞的 tinypool 1.x pool）并设定
`vite >=7.3.7 <8`、`source-map-js ^1.2.2` 范围内下限关闭。本仓库 vitest 4 迁移的
接缝（manifest 包装模块、清空启动参数的测试 setup 文件、mock 摆放位置）见
0.11.0 的原版详细记录。

## Upstream references and follow-up / 上游参考与后续更新

- [DSH public dependency discussion](https://github.com/deepseek-ai/deepseek-harness/discussions/10847) records concerns about exact-pinned vulnerable dependencies. It does not establish that DSH maintainers have responded or scheduled a repair.
- [Undici 8.12.2 release](https://github.com/nodejs/undici/releases/tag/v8.12.2) lists the upstream fixes for these three advisories. That release does not replace code in an already signed DSH app. The reviewed rc.3, rc.4, rc.5 and alpha.2 host manifests still pin Undici 8.11.2.

- [DSH 公开依赖讨论](https://github.com/deepseek-ai/deepseek-harness/discussions/10847)记录了精确锁定受影响依赖的担忧；不能据此声称 DSH 维护者已回应或已排期修复。
- [Undici 8.12.2 发布记录](https://github.com/nodejs/undici/releases/tag/v8.12.2)列出了这三条公告的上游修复，但该发布不会替换已有签名 DSH 应用内的代码。本次核对的 rc.3、rc.4、rc.5 和 alpha.2 宿主 manifest 仍锁定 Undici 8.11.2。

Once an official compatible host carries the fixed dependency chain, recheck its actual signed/installed bytes and advisory result, validate the changed inputs, then update this disclosure and remove or reassess only the matching exceptions. Until then, the residual risk remains accepted only within the recorded scope and expiry; other acceptance gates stay in force.

后续官方兼容宿主带入修复链后，应重新核对实际签名及安装字节、公告扫描结果和受影响输入，再更新披露，并仅移除或重新评估相符的例外。在此之前，剩余风险只在已记录的范围和期限内被接受，其他验收门禁继续有效。
