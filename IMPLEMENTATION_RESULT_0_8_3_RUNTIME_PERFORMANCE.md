# DSH Completion Guard 0.8.3 实施结果（运行时性能与实现修复）

日期：2026-10-01。本文件是实施交回（agent-handoff/v1），不是发布记录。
分工（用户 2026-10-01 指定）：本仓库实现、回归、性能前后对照、文档与本地候选交回由 ZCode 完成；独立复核、最终制品冻结、跨平台原生/UI/模型验收与发布由 Codex 负责。

## 1. 候选身份

| 项目 | 值 |
| --- | --- |
| 审查基线 | `913a4c7a6f0f600f4146ef4af694d3af6e477ef2`（package 0.8.2，工作区干净，仅三份计划文件未跟踪） |
| 实现提交 | `45bb8099991dedb596cd66af8b20aa10536d097a`（分支 `candidate/0.8.3-runtime-performance`，仅本地，未 push） |
| 版本 | 0.8.3（package.json；入口核对时 0.8.3 未被占用） |
| dirty state | 交回文档提交后干净（见 §7） |
| dist | 从干净提交重建，`git diff --exit-code -- dist` 通过（DIST_SYNC_OK） |
| 实际解释器 | Node v25.1.0、pnpm 11.22.0、Vitest 3.2.7、tsdown 0.15.12、macOS arm64。路径名称不作为版本证据；Node 22/24 portability 仍未验证（CI pending） |

## 2. 问题结案表

| ID | 现象（复现） | 根因 | 修复 | 回归 | 状态 |
| --- | --- | --- | --- | --- | --- |
| PERF-01 | 生产函数计数：一次 attach 得 2 次 derive；无变化连续 sync 每次 1 次 derive（`tests/v082-projection-scaling.test.ts` cold_mount derive_calls [2]、warm_sync [1]） | `ensure→createRuntime→rebuild` 后 attach 无条件 `runtime.sync()`；sync 无输入变化判定 | attach 只在 runtime 已存在时 sync；plain sync 增加无变化快路径（session seq+header、durability、Goal 读回、私有账本当前值为 key；`revalidateHostLock` 恒重建）；core/v2 复用同一次事件快照 | `tests/v083-runtime-perf-counts.test.ts` 锁定计数（attach=1、warm=0、durability 翻转/新事件=1）；A/B 计数 cold_mount [2]→[1]、warm_sync [1]→[0] | 已关闭 |
| PERF-02 | v6 合成压力：10k 档 derive 1.26s、cold_mount 3.16s；capture 内 nextId/重复搜索 O(N²)；core/v2 每 item 重复物化并扫描全部 evidence（O(N×E²)） | 逐项全表扫描；无索引 | `src/domain/item-fold-index.ts`（nextId/nextNumericId/重复搜索的精确镜像索引，4 个写入点全部注册）；core/v2 共享 evidence 索引（callId/subject/ordinal 保序）；per-root 文本/摘要缓存；`DSH_GUARD_DISABLE_INDEXES=1` 保留原始全量路径 | `tests/v083-projection-index-differential.test.ts`：随机族夹具每个事件前缀（44 个前缀）+ 全量 log，索引开/关 canonical 输出逐字节一致；全量 Vitest 2902 通过 | 已关闭（增量化 reducer 未做：预算未要求且风险大，见 §5 缺口） |
| PERF-03 | Desktop 每次校验重复读 ASAR header/metadata/module bytes（runtime 识别、字节审计、依赖路由、渲染器审计各自读） | 无操作内共享 | `readDesktopAppRuntime`/`auditDesktopInstalledImplementation`/`readDesktopDependency` 接受可选 HostAuditSession，index 与 entry bytes memo 在单次校验的 session 上（生命周期=一次校验，无跨 entry 缓存）；`reevaluateDesktopCoreLock` 全链共用一个 session | Desktop 家族 66+38 项测试通过；真实 Desktop 测量入口建立但本机 digest 漂移无法完成数字验收（见 §5） | 已关闭（代码与计数）；数字验收 pending |
| PERF-04 | 显式 workdir/后台 echo 仍触发 1 audit + 1 route + 1 sync | 审计先于资格判定 | pre-execute 增加从 receipt 必要条件（`captureHostWorkdir`+`sourcedNamedTestRoot`）提取的保守预筛：非前台根 `npm test`/`pnpm test`、显式 workdir、后台、非根调用零审计；可能命中者保持原新鲜路径 | `tests/v083-runtime-perf-counts.test.ts`：echo×3（含显式 workdir、后台）= 0 次 fresh audit；`npm test` ≥ 1 次 | 已关闭 |
| PERF-05 | append 重读 anchors+全账本；每投影读账本受全会话数与账本长度共同影响 | 读路径重复 | `readVerifiedLedgerRecords` 单次读+链验证共享；append 持锁期间只读一次 | `tests/private-ledger-v070.test.ts` 6 项通过；scaling 夹具新增 1000-anchors 维度（median 2.3ms） | 已关闭 |
| BUG-01 | 遗留 `.writer.lock`（匿名 O_EXCL 空文件）使 append/initialize 永久失败 | 锁无 owner 身份，崩溃后不可恢复 | 锁记录 v2 {nonce, pid, hostname, created_at}；同机且 pid 可证实死亡时原子回收（unlink 前 inode+size+内容重检）；legacy/外主机/存活 owner 保持拒绝；`writerLockState()` 提供诊断 | `tests/v083-private-ledger-lock.test.ts` 5 项：死 owner 回收、存活不抢、legacy 不删、外主机拒绝、顺序 append | 已关闭 |
| BUG-02 | 初始 commit 无 parent，observer 返回 `native_git_readback_unavailable` | 强制 `git rev-parse HEAD^` | parent 从 commit 对象读（`git rev-list --parents -n 1 HEAD`）：单 token 为显式已验证 `root` 父身份（`NATIVE_GIT_ROOT_PARENT_OID`）；consumer 接受 OID 或该哨兵，绑定/摘要不变 | `tests/v083-git-observer.test.ts`（真实仓库）；`tests/native-file-v2.test.ts` 16 项全过（普通 commit 摘要不变） | 已关闭 |
| BUG-03 | 失败 hook 回显旧 HEAD 仍 `git_commit_observed`；Git 查询未传取消 | observer 只验 envelope，不复用 shell 终态判定 | 复用 evidence 层分类（`shellReadbackOutcome`）：失败/后台/截断/不可归类一律不宣称 observed；subprocess 传 `AbortSignal.any([exec.signal, 20s timeout])`，单查询仍 5s；链级断言：失败调用 effect evidence outcome=failure 且 certifyCheckpoint 不可认证 | `tests/v083-git-observer.test.ts` 4 项（root commit、失败 hook、后台、取消传播）；`tests/v082-obscured-terminal-marker.test.ts` 家族全过 | 已关闭 |
| VAL-01 | 夹具每 slab 拼 `V5\nV6` 无法被精确识别；真正 v6 边界在全历史之后（主体 legacy fold）；cold_mount durability 未 confirmed；只采样当前 RSS | 夹具构造错误 | 夹具重写：v6 边界为首条持久事件、0 档真零事件、走真实 agent/pre-step flush→setDurability→sync 路径、新增 legacy 对照/1000 anchors/峰值 RSS/warm sync 条目、断言 protocol=6+items>0+core 可投影 | baseline/candidate 均用同一新夹具测量（§4） | 已关闭 |
| VAL-02 | 测量脚本用 RC.1 manifest；profile 非 web 一律映射 headless | manifest 未更新；入口缺失 | 主基线改 `manifests/rc020-rc2-byte-audit.json`（`--manifest` 可显式回放历史）；v081 测试支持 `desktop` kind（要求显式 `DSH_MEASURE_DESKTOP_DIGEST`）；驱动直连本地 vitest（去除 pnpm TTY 依赖） | 真实 Desktop 入口在本机运行至 checkpoint（digest 漂移 fail-closed，见 §5） | 已关闭 |
| VAL-03 | `host_audit_tooling` 输出 `static_contracts`，runner 不认识 → 映射计划被拒 | map 与 runner 词表不一致 | runner 增加 `static_contracts`（运行两个 gated 测量套件的收集/合同断言）；新增词表一致性测试（map 全部 gate ⊆ runner KNOWN_GATES；host_audit_tooling 计划可执行；未知 gate 仍 fail-closed） | `tests/validation_selection_test.py` 21 项通过 | 已关闭 |

新增问题：无新增可复现 P1。发现并保留的既有行为（非缺陷，安全方向）：asset obligation 无 raw-text 绑定使其所在 current unit 的 core 快照 fail-closed 为 `source_not_projectable`（差分夹具建立时确认，core 家族既有断言覆盖）。

## 3. 合同保持（未降级）

- root provenance、引用/计划/晚答/委托过滤、work-unit 继承、禁止项、条件等待、目标身份、durable watermark、Stop/Goal/release 语义不变；差分 oracle 逐前缀一致。
- `revalidateHostLock` 恒重建；最后一次 await 后的 fresh pre-effect gate 不变；并发 entry 的 AsyncLocalStorage 隔离不变。
- 无 TTL/mtime/size/安装收据/watcher 静默/跨 entry 缓存：Desktop session 生命周期=一次校验；账本 append 每次重新取锁并重读当前文件；fast path 的 key 是各输入的当前值。
- worker/增量 reducer 未引入；Codex Context Guard upstream pin/oracle/expected 未触碰。

## 4. 性能 A/B（同输入同方法，5 个 fresh worker/档，median；p95 与原始样本见证据文件）

环境：macOS arm64、Node v25.1.0、独占运行（正确性测试完成后）。夹具：正常 confirmed v6 会话（边界为首条事件），每 slab 一条根输入 + 3 次工具往返（一个 200KB/2KB 长输出）。

| events | entry | 0.8.2 baseline | 0.8.3 candidate | 倍率 | derive 调用 |
| --- | --- | ---: | ---: | ---: | --- |
| 3004 | cold_mount | 373.5 ms | 167.1 ms | 2.2× | [2]→[1] |
| 3004 | confirmed_sync_first | 377.5 ms | 231.0 ms | 1.6× | [1]→[1] |
| 3004 | warm_sync（无变化） | 362.2 ms | 0.1 ms | ~3600× | [1]→[0] |
| 3004 | derive_projection（纯 fold） | 170.0 ms | 156.1 ms | 1.09× | — |
| 10004 | cold_mount | 3150.3 ms | 1055.2 ms | 3.0× | [2]→[1] |
| 10004 | confirmed_sync_first | 3109.0 ms | 1334.1 ms | 2.3× | [1]→[1] |
| 10004 | warm_sync（无变化） | 3006.9 ms | 0.1 ms | ~30000× | [1]→[0] |
| 10004 | derive_projection（纯 fold） | 1222.7 ms | 1043.6 ms | 1.17× | — |
| 10004 | derive_projection_legacy | 705.2 ms | 659.7 ms | 1.07× | — |
| — | private_ledger_short（4 records） | 0.18 ms | 0.19 ms | 持平 | — |
| — | private_ledger_long（400 records） | 3.32 ms | 3.77 ms | 噪声内 | — |
| — | private_ledger_1000_anchors（新维度） | 未测 | 2.28 ms | — | — |

峰值 RSS（median）：10k 档 cold_mount 879→856 MB、confirmed 884→873 MB，无驻留增长。p95 与全部原始匿名样本：`/Users/lgr59/Documents/Github/dsh-cg-evidence-083/baseline-projection-scaling-full.json`、`candidate-projection-scaling.json`（schema `dsh-projection-scaling/v1`，含每次运行的 source_sha256；两报告的 commit 字段均为 913a4c7a，因测量运行时实现尚未提交，实际源码由 source_sha256 与上表行数区分）。

对照计划预算（§5.3）：
- 无变化纯投影 refresh：≤1k p95 ≤5ms → 实测 0.1ms，derive/core 0 次 ✓
- attach 重复工作：一次 fold、一次 host validation ✓
- 不可能产收据的普通 shell：full audit 0、route audit 0 ✓（计数）；pre-execute 附加耗时未单列计时（预筛为常数级字符串判定）
- 重历史首轮投影 3k 档 ≥4×：**未达标**（2.2×）。归因：剩余成本=一次完整 `deriveProjection`（3k 156ms/10k 1044ms，其中 v6 逐条分段/捕获约为 legacy fold 的 1.6 倍，legacy 660ms 为下界参考）。进一步消除需计划 S2 第 4 条的增量 reducer 或分段缓存，属计划明确的第二层选项，本次未引入。10k 压力档完成、无卡死/OOM（峰值 873MB）✓
- 大历史 Guard 增量 p95 减少 ≥50%：无变化切换路径 Guard 增量 362→0.1ms（100%）✓；端到端 UI 待原生验收
- Desktop 每类 entry 计数/时间：代码与计数就绪；本机实测被 digest 漂移阻断（§5）

## 5. 未达标/未验证项（pending，不因测试全绿宣告完成）

| 项 | 现状 | owner / 恢复事件 |
| --- | --- | --- |
| 首轮投影 4× 预算 | 实测 2.2×–3.0×；缺口=单次全量 fold（v6 分段捕获为主） | Codex 复核时决定是否批准增量 reducer/分段缓存设计；在批准前保持现状 |
| Desktop 数字验收 | 本机 `/Applications/DeepSeek Harness.app` + `~/.dsh/profiles/desktop` 注入 digest `4dc729f6…` 与当前盘面计算的 `9d3a5aa1…` 不一致（0.8.2 基线代码计算结果相同，证明是安装后环境漂移而非候选回归；runtime revalidation 结果仍 `supported` 前置于 digest 比较，测量在 checkpoint 处 fail-closed 为 unknown） | Codex 原生验收：新装/重注入后以 `scripts/measure-host-audit.mjs --measure --desktop-digest <sha> <app.asar> <profileRoot> desktop` 复测（macOS/Windows） |
| candidate CI（六 lane） | 未 dispatch（未获授权；且 dispatch 属 Codex 流程） | Codex：在精确候选上运行 CI portability screen |
| canonical artifact / exact tgz | 未打包（按分工归 Codex 冻结；从 `45bb809` 或其后的干净提交生成） | Codex：`node scripts/release-pack.mjs --source . --output-dir <外部目录>` |
| Windows native / Web+Desktop UI 端到端 / 真实模型验收 | 未执行，无凭据/授权 | Codex 原生批次（复用既有登录） |
| Node 22/24 portability | 本机仅 Node v25.1.0；portability 由 CI lane 证明 | 随 candidate CI |
| docs exact-byte cold review | 文档审计 0/0，README 无新增性能宣称（changelog 只含可证实表述）；最终字节级读者审查未做 | Codex reader review |

## 6. 命令与结果（freeze 时点）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| typecheck | `node node_modules/typescript/bin/tsc --noEmit` | 0 errors |
| lint | `node node_modules/oxlint/bin/oxlint src tests` | 0 errors / 91 warnings（与基线逐一比对无新增） |
| tests | `node node_modules/vitest/vitest.mjs run` | 180 files passed / 1 skipped；2902 passed / 11 skipped |
| release-pack | `node --test tests/release-pack.node.mjs` | 4/4 |
| stats | `node --test tests/npm-download-stats.node.mjs` | 10/10 |
| build | `node node_modules/tsdown/dist/run.mjs` + 干净提交重建 + `git diff --exit-code -- dist` | 通过（DIST_SYNC_OK） |
| pack:check | `pnpm pack --dry-run --json` | exit 0，44 files |
| docs audit | `python3 scripts/audit_repository_documentation.py .` | 0 errors / 0 warnings（35 markdown） |
| docs/validation python | `python3 -m unittest`（docs/validation/selection/required-jobs/workflow/native×3/cross-end） | 105 tests OK |
| git | `git diff --check` | 通过 |

## 7. 变更清单（实现提交 45bb809）

- src：`runtime.ts`（PERF-01/04）、`domain/item-fold-index.ts`（新）、`domain/derive.ts`（PERF-02 索引+memo）、`core-v2/session.ts`（PERF-02 共享索引，181 行变更）、`domain/host-desktop.ts`+`host-resolver.ts`（PERF-03）、`domain/private-ledger.ts`（PERF-05+BUG-01）、`domain/evidence.ts`+`tools/observe.ts`（BUG-02/03）、`domain/supersession.ts`/`rebind.ts`（索引注册）。
- tests：`v083-projection-index-differential`（新）、`v083-private-ledger-lock`（新）、`v083-git-observer`（新）、`v083-runtime-perf-counts`（新）、`v082-projection-scaling`（VAL-01 重写）、`v081-host-protocol-measurement`（VAL-02）、`validation_selection_test.py`（VAL-03）、`artifact-entry`（版本字面量）。
- scripts：`measure-projection-scaling.mjs`、`measure-host-audit.mjs`（VAL-02）、`run_selected_validation.py`（VAL-03）。
- docs/package：双语 changelog 0.8.3、package.json 0.8.3、dist 同步。
- 本仓计划/提示词/交接三文件保持未跟踪，由接收方决定是否入库。

## 8. agent-handoff/v1 结果

```json
{
  "schema": "agent-handoff/v1",
  "state": "ready_for_independent_acceptance",
  "repositories": [{
    "id": "dsh_completion_guard",
    "url": "https://github.com/GreenLv/dsh-completion-guard",
    "base_sha": "913a4c7a6f0f600f4146ef4af694d3af6e477ef2",
    "head_sha": "45bb8099991dedb596cd66af8b20aa10536d097a",
    "branch": "candidate/0.8.3-runtime-performance",
    "pushed": false,
    "version": "0.8.3"
  }],
  "issue_closure": { "closed": ["PERF-01","PERF-02","PERF-03","PERF-04","PERF-05","BUG-01","BUG-02","BUG-03","VAL-01","VAL-02","VAL-03"], "new_p1": 0 },
  "validation": [
    { "id": "candidate_matrix", "status": "passed", "subject": "45bb8099991dedb596cd66af8b20aa10536d097a", "note": "typecheck/lint/tests/release-pack/stats/build+dist-sync/pack:check/docs-audit/python-suites/diff-check per IMPLEMENTATION_RESULT §6" },
    { "id": "performance_ab", "status": "passed", "subject": "same-input A/B, 5 fresh workers per size", "evidence_ref": "IMPLEMENTATION_RESULT §4 + dsh-cg-evidence-083/*.json" }
  ],
  "pending_gates": [
    "first_projection_4x_budget (2.2x-3.0x measured; needs reviewer decision on incremental reducer)",
    "candidate_ci_six_lanes",
    "canonical_artifact_freeze (owner: Codex)",
    "macos_desktop_numeric_measurement (injected digest drifted vs disk, baseline code identical; re-inject on fresh install)",
    "windows_native",
    "web_desktop_ui_end_to_end",
    "model_behavior",
    "node_22_24_portability",
    "reader_exact_byte_review"
  ],
  "out_of_scope_performed": [],
  "notes": "Local candidate only; no push, no tag, no npm/GitHub Release, no daily-profile installation or restart. Raw anonymous measurement and logs live outside the source tree (dsh-cg-evidence-083/). The desktop digest drift reproduces identically under the 0.8.2 baseline code and is therefore an environment drift, not a candidate regression; runtime revalidation on the installed app still reports supported before the digest comparison and the measurement fail-closes closed at the checkpoint entry."
}
```
