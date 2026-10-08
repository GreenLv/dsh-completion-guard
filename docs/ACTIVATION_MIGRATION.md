# Session activation migration / 会话启用模式迁移

0.9.0 makes `always` the default for **new unseeded root sessions**. It preserves each old session's pre-upgrade effective mode using a write-once private binding. Mode is independent of `standard` policy, execution/publication authority and completion certificates. Empty old sessions belong in the inventory too. Recorded off/on continues to control enablement; neither configuration nor adoption re-signs history.

0.9.0 将**新建无继承根会话**的默认模式改为 `always`，旧会话通过不可覆盖私有绑定保留升级前有效模式。模式独立于 `standard` 策略、执行与发布权限及完成证书。旧空会话也必须清点，已记录的 off/on 继续控制启用状态；配置及 adoption 都不重签历史。

## Prepare before changing the installed version / 升级前准备

Stop the relevant Web, Headless and Desktop session writers. Preserve their installed old package and effective configuration readback before upgrade. The new toolkit may run from an independently prepared candidate directory while the old Guard remains installed. Do not read the upgraded default and label it an old mode. Do not include credential values or session bodies in the readback.

先停止相关 Web、Headless、Desktop 会话写者，在升级前保留旧安装包身份及有效配置回读。可从独立准备的候选工具目录运行新工具，此时旧 Guard 仍安装在原位。不能把升级后的新缺省当作旧模式，不得在回读中包含凭据或会话正文。

Prepare an operator-owned JSON file in the following format. `previousPackage.sha256` identifies the preserved old package bytes; `sourceSha256` hashes the relevant sanitized, pre-upgrade source readback. Cohort names describe that verified source. If all relevant cohorts have one known mode, that uniform mode can cover the inventory. If modes differ, each session needs an explicit `sessionIds` mapping based on verified old provenance; absent or contradictory mappings stay `pending`. Profile paths, dates, event counts and `on` markers cannot supply that mapping. A checksum checks integrity; it is not an issuer signature or proof that an operator's asserted mapping is correct.

准备以下格式的操作者 JSON 文件。包摘要指向保留的旧包字节，来源摘要指向相关的脱敏升级前回读。来源组名描述已核验来源。所有相关来源模式一致时可覆盖库存；模式不同则必须提供基于已核验旧来源的 `sessionIds` 映射，缺失或冲突保持 `pending`。不能用 profile 路径、日期、事件数量或 on 标记替代来源映射。摘要核验完整性，不是发行签名，也不能证明操作者的映射断言正确。

```json
{
  "schema": "dsh-activation-prior-modes/v1",
  "previousPackage": {
    "name": "dsh-completion-guard",
    "version": "0.8.4",
    "sha256": "<64 lowercase hex characters>"
  },
  "sourceSha256": "<64 lowercase hex characters>",
  "cohorts": [{ "name": "verified-old-web", "mode": "opt-in" }]
}
```

## Official old-format refusals and an explicit readable subset / 官方旧格式拒绝与显式可读子集

The official persistence reader may reject an older session with `SessionFormatUnsupportedError`. This names a host format-support boundary; it does not by itself prove corruption or a Guard regression. Do not delete, rewrite, rename or repair the raw log to force acceptance. Preserve it, the old package and its verified effective-mode source. `inventory` can record this **specific official open refusal** as pending. Other failures (corruption, permissions, missing files, unknown errors, list/stat failure or drift) abort; they are not automatically skipped. Default `inspect/adopt/verify` still requires the whole inventory to be readable.

官方 persistence 可能以 `SessionFormatUnsupportedError` 拒绝旧格式会话。这说明宿主格式支持的边界，本身不证明日志损坏或 Guard 回归。不要删除、重写、改名或“修复”原日志来绕过拒绝；保留原日志、旧包和已核验的旧有效模式来源。inventory 只将这类**官方 open 拒绝**记为 pending；损坏、权限、丢失、未知异常、list/stat 失败或库存变化均中止，不会被自动跳过。默认 inspect/adopt/verify 仍要求整库可读。

Suppose an inventory contains N sessions, of which M are readable. First freeze the full report, then review the local `rows` and write a JSON array containing only the readable IDs you explicitly choose, for example `["chosen-a", "chosen-b"]`. The example IDs are placeholders; use exact report IDs. No automatic “all readable” selection is made. The report and manifests contain private IDs and metadata hashes, but no event bodies or credentials; keep them local and owner-only. Run this phase before replacing either the host or Guard, with writers stopped. You can copy the preserved logs into a separate, access-controlled workspace for later host-format diagnosis; never change the authoritative originals or share their contents.

假设库存共 N 个会话，其中 M 个可读。先冻结全库报告，查看本地 rows，再将明确选中的可读 ID 写入 JSON 数组，如 `["chosen-a", "chosen-b"]`。示例 ID 是占位符，必须换成报告中的精确 ID；工具不会自动选择“所有可读”。报告与清单含私有 ID 和元数据摘要，不含正文或凭据，应仅在本地以所有者权限保存。替换宿主或 Guard 前、写者停止时完成这一阶段。后续宿主格式诊断可使用另行受控保管的日志副本，不能改动权威原件或外传正文。

```sh
# POSIX shell; use distinct unused output paths. Match compression to the real config.
node /absolute/prepared-package/bin/dsh-completion-guard-activation.mjs inventory \
  --runtime-anchor /path/to/runtime/package.json \
  --persistence-root /path/to/active-session-storage \
  --output /path/to/inventory.json

# chosen-ids.json is an operator-reviewed JSON array of exact readable IDs.
node /absolute/prepared-package/bin/dsh-completion-guard-activation.mjs select \
  --inventory /path/to/inventory.json \
  --include-file /path/to/chosen-ids.json \
  --output /path/to/selection.json

node /absolute/prepared-package/bin/dsh-completion-guard-activation.mjs inspect \
  --runtime-anchor /path/to/runtime/package.json \
  --persistence-root /path/to/active-session-storage \
  --selection /path/to/selection.json \
  --prior-modes /path/to/old-mode-source.json \
  --output /path/to/selected-receipt.json

# After replacement, before upgraded host startup:
node /absolute/prepared-package/bin/dsh-completion-guard-activation.mjs adopt \
  --runtime-anchor /path/to/runtime/package.json \
  --persistence-root /path/to/active-session-storage \
  --selection /path/to/selection.json \
  --receipt /path/to/selected-receipt.json \
  --dsh-home /path/to/actual-dsh-home

node /absolute/prepared-package/bin/dsh-completion-guard-activation.mjs verify \
  --runtime-anchor /path/to/runtime/package.json \
  --persistence-root /path/to/active-session-storage \
  --selection /path/to/selection.json \
  --receipt /path/to/selected-receipt.json \
  --dsh-home /path/to/actual-dsh-home
```

`inventory_scanned` reports total/readable/unsupported counts and creates the frozen report. `selection_ready` creates the explicit scope manifest; empty, duplicate, unknown or unsupported IDs refuse. Selected `inspect` reports `ready` only when all included identities have verified old sources, then writes a receipt. Mixed-mode sources need exact per-session mappings. Source mappings may cover excluded IDs too, but exclusions never acquire a mode binding. Never infer a mode from format, date, path, event count or a new default.

inventory_scanned 表示已生成全库报告及总数/可读/拒绝数量；selection_ready 表示已冻结显式范围，空选、重复、未知或被拒绝 ID 都会拒绝。子集 inspect 仅在所有包含会话的旧来源均可核验时返回 ready 并创建收据。混合模式需逐会话映射；旧来源映射可以包含排除项，但排除项不会被写入模式绑定。不得按格式、日期、路径、事件数或新默认值猜模式。

Every selected `inspect/adopt/verify` rescans the **whole** inventory and checks all listed header/revision hashes, readable birth identities and refusal statuses against the selection. Added, removed, replaced or changed rows—including excluded ones—or changed readability invalidate the scope before adoption. Supplying the same manifest is mandatory on all three commands; full and selected receipts cannot be substituted. An integrity digest binds the asserted inputs; it is not authority or proof that an old-source assertion is true. A host upgrade that changes the scan requires a fresh report and reviewed scope before proceeding.

每次子集 inspect/adopt/verify 都重扫**全库**，核对全部 list header/revision 摘要、可读出生身份及拒绝状态。新增、删除、替换、变化（包括排除项）或可读性变化，会在 adoption 前使范围失效。三条命令均须携带同一 selection，不能混用全库与子集收据。摘要只绑定断言输入，不提供权限，也不能证明旧来源断言正确。宿主升级若改变清点结果，必须重新生成报告并审核范围后再继续。

`selected_complete` means that **only the receipt-selected rows** completed or verified. `selected_partial` means one or more of those rows refused. Both report `scope: receipt_selected`, `wholeInventoryStatus: not_claimed`, and a pending list for all exclusions (`session_format_unsupported` or `not_selected`). Pending remains visible even if the command exits zero. Repeat adoption for the same unchanged scope: completed rows are byte-identical no-ops; missing rows can continue, conflicts remain refused and intact. `verify` never writes. Preserve all existing reports and receipts; `activation_output_exists` requires a new output name, not deleting the old evidence. Drift requires new inventory/selection/inspect, not editing a digest or reusing a stale scope. The older full-inventory path below remains available without `--selection`.

selected_complete **仅表示收据选中行**完成或核验通过；selected_partial 表示其中至少一行拒绝。两者均输出 scope: receipt_selected、wholeInventoryStatus: not_claimed，以及所有排除项的 pending 清单（session_format_unsupported 或 not_selected）。命令即使零退出，也不能隐藏 pending 或称为整库完成。相同且未变的范围可重复 adopt：完成行字节不变，缺失行可继续，冲突拒绝且原状保留；verify 从不写入。保留旧报告和收据；activation_output_exists 应换一个输出文件名，而不是删除证据。库存变化后重新 inventory/selection/inspect，不能改摘要或复用过期范围。下方不带 --selection 的原整库路径仍可用。

When a later official host supports the pending format, use its **read-only** persistence reader on the preserved log, generate a fresh inventory, compare actual birth identity and re-establish the preserved old-mode source. Confirm that the existing user authorization covers the newly included scope; ask only if it does not. Create a new selection and receipt, then adopt and verify. A previous migration receipt or certificate grants no new migration/publication authority. If the reader still refuses or the source cannot be recovered, retain pending and continue new work in a fresh qualified root session; do not fabricate origin, inherited cut, old mode or receipt. The original history remains available for later support.

以后官方宿主支持这些格式时，用该宿主的**只读** persistence 读取保留日志，生成新库存，核对实际出生身份并重新核验保留的旧模式来源；核对已有用户授权是否覆盖新增范围，仅在未覆盖时补充确认；随后生成新 selection/收据，再 adopt 和 verify。旧收据或证书不授予新迁移或发布权限。仍拒绝或无可恢复来源时保持 pending，可在新的合格根会话继续工作；不能伪造 origin、继承 cut、旧模式或收据。原历史保留以等待后续支持。

### Copyable migration prompts / 可复制迁移提示词

> Help me migrate session activation to DSH Completion Guard 0.9.0. Lifecycle constraint: [fill in which writers may be stopped and whether restart is allowed]. Reuse scope, write and lifecycle authorization already supplied in this conversation; ask only for missing or materially changed decisions. First report the current host/persistence/compression settings, preserved 0.8.x package identity and sanitized pre-upgrade effective-mode sources. If they cannot be verified, keep affected sessions pending. Do not replace packages, stop/restart processes or write bindings before that lifecycle and mutation authority is established. Run the packaged read-only inventory command; show total/readable/official-format-refused counts and a local pending report. Use my existing explicit selection, or ask me to choose the included scope if none was supplied; do not silently expand it or treat readability alone as authorization. Bind that explicit selection through inspect/adopt/verify, detect all inventory changes, preserve raw logs and old sources, and never infer modes/origin/cuts from paths, dates or event counts. No log bodies, credentials or private IDs leave my machine. Once the scope and writes are covered by my authorization, adopt, repeat to check no-op, and verify; report selected completion and remaining pending separately. For unsupported rows, give the future official-reader/re-inventory/source-validation route; without a recoverable source, keep pending or use a new session. Do not treat old certificates as new authority.

> 帮我迁移到 DSH Completion Guard 0.9.0 的会话启用模式。生命周期约束：[填写允许停止的写者及是否允许重启]。沿用本会话已给出的范围、写入及生命周期授权，仅询问缺失或实质变化的决定。先报告现有宿主、持久化目录/压缩配置、保留的 0.8.x 包身份及脱敏的升级前有效模式来源；不能核验就将受影响会话保持 pending。取得明确生命周期和写入权限前，不替换包、不停/重启进程、不写绑定。运行打包工具的只读 inventory，报告总数/可读/官方格式拒绝数量并保存本地 pending 报告；沿用我已明确选择的范围，尚未选择时再请我决定；不静默扩大范围，也不把可读性本身当作授权。让显式 selection 贯穿 inspect/adopt/verify，检测全部库存变化，保留原日志和旧来源，不按路径、日期、事件数猜模式/origin/cut。正文、凭据、私有 ID 不离开本机。范围和写入已有授权覆盖后 adopt、重复检查 no-op，再 verify，分别报告选中行完成及剩余 pending。被拒绝项给出未来官方读取器支持后重盘点、核验身份/旧来源的方案；没有可恢复来源就保留 pending 或改用新会话。旧证书不当作新权限。


## Full-inventory inspect, adopt, verify / 整库清点、采纳、核验

The entry `node /absolute/prepared-package/bin/dsh-completion-guard-activation.mjs` below uses the independently prepared 0.9.0 toolkit; it does not assume a new command is installed on PATH while the old Guard remains installed. The tool mounts only the official JSONL persistence service, without starting the agent loop, UI or model. `--runtime-anchor` is a file in the physical official runtime; the tool resolves its real path before loading dependencies. `--persistence-root` and optional `--compression none|zstd` must match the active persistence configuration. No storage path or encoding is guessed. Inspection uses public `list`, read-only `open`, exact header/inherited-cut metadata and revision readback; it outputs no event bodies. Keep writers stopped through the sequence.

下方使用独立准备的 0.9.0 工具入口 `node /absolute/prepared-package/bin/dsh-completion-guard-activation.mjs`，不假定旧 Guard 仍安装时新命令已在 PATH。工具只挂载官方 JSONL persistence 服务，不启动 agent loop、界面或模型。runtime anchor 必须是官方 runtime 中的文件，加载依赖前先解析物理路径。持久目录及可选压缩格式必须匹配实际配置，不推测目录或编码。清点使用公开 list、只读 open、精确 header/cut 元数据及 revision 回读，不输出事件正文。整个操作期间保持写者停止。

The following example is for a POSIX shell. Run `inspect` before replacement; run `adopt` and `verify` before starting the upgraded host. Keep the prepared toolkit path explicit throughout.

以下示例使用 POSIX shell：替换前执行 inspect，升级后的宿主启动前执行 adopt 和 verify，全程使用明确的候选工具路径。

```sh
node /absolute/prepared-package/bin/dsh-completion-guard-activation.mjs inspect \
  --runtime-anchor /path/to/runtime/package.json \
  --persistence-root /path/to/active-session-storage \
  --prior-modes /path/to/old-mode-source.json \
  --output /path/to/frozen-migration.json

node /absolute/prepared-package/bin/dsh-completion-guard-activation.mjs adopt \
  --runtime-anchor /path/to/runtime/package.json \
  --persistence-root /path/to/active-session-storage \
  --receipt /path/to/frozen-migration.json \
  --dsh-home /path/to/actual-dsh-home

node /absolute/prepared-package/bin/dsh-completion-guard-activation.mjs verify \
  --runtime-anchor /path/to/runtime/package.json \
  --persistence-root /path/to/active-session-storage \
  --receipt /path/to/frozen-migration.json \
  --dsh-home /path/to/actual-dsh-home
```

`inspect` creates a new owner-only receipt with exclusive creation, or reports exact unresolved session IDs and exits nonzero without creating an adoptable receipt. `adopt` first checks receipt identities against the current public inventory, then writes each binding separately; `verify` never writes. A conflict leaves the other completed rows intact and reports `partial`. Repeating adoption is a byte-identical no-op for completed rows and continues missing rows. Claim completion only after all receipt rows verify. A newly appearing session is not silently included in an old receipt.

inspect 排他创建仅所有者可访问的新收据，或报告未解决会话 ID 并非零退出，不生成可采纳收据。adopt 先用当前公开库存核对身份，再逐会话写绑定；verify 不写入。冲突保留其他已完成行并报告 partial，重复采纳对已完成行字节不变，继续缺失行。所有收据行核验通过后才可报告该收据迁移完成；新出现的会话不会被静默加入旧收据。

## Restore, diagnosis and rollback / 恢复、诊断与回退

Bindings live under `DSH_HOME/completion-guard/activation-bindings-v1` (`~/.dsh` when unset), with one hashed slot per SessionId. Birth identity includes createdAt, parent, seeded flag, exact inherited cut, origin and delegation depth; preset, cwd, profile and host lock do not change it. Existing mode overrides defaults. A contradictory explicit configuration refuses `activation_mode_conflict`; removing that contradictory override restores the original binding semantics. To choose another initial mode, create a new root session. Restore/clear/compact/late attach never create a missing binding.

绑定位于上述私有目录，一个 SessionId 对应一个摘要槽。出生身份包含 createdAt、父会话、seed 标记、精确继承 cut、来源及委派深度；preset、cwd、profile、宿主锁不改变模式身份。已有模式覆盖缺省，显式矛盾报具名拒绝；移除矛盾覆盖可恢复原绑定语义，选择另一初始模式请新建根会话。恢复、清空、压缩、迟挂载不补建缺失记录。

Missing/corrupt/changed records invalidate cached projections and certification. Inspect the named reason, then use the preserved verified receipt to adopt the same missing old identity/mode. Corrupt or conflicting final slots refuse automatic repair; preserve them for diagnosis. If no trusted old source remains, keep the session unknown and establish new work in a fresh qualified session. This does not delete history or trigger an endless correction loop. Forks require a parent binding and inherit its mode; the exact cut is supplied and validated by the official Session/persistence contract, without mode inference from prefix length.

缺失、损坏或变化的记录使缓存投影和认证失效。根据具名原因诊断，再使用保留且已核验的收据采纳同一缺失旧身份与模式。损坏或冲突的 final 拒绝自动修复，请保留诊断；无可信旧来源时保持 unknown，在新合格会话中建立新工作。不删除历史，也不触发无穷纠正。fork 需核验父绑定并继承父模式；精确 cut 由官方 Session/persistence 合同提供及验证，不由前缀长度推断模式。

A fresh 0.9.0 creation that leaves `.pending` has no general recovery command in this toolkit. `inspect` accepts preserved pre-0.9.0 sources, and `adopt` requires a verified legacy migration receipt; neither permits inventing such a receipt for a fresh creation. Without an existing trusted legacy receipt, keep the mode unknown, diagnose the retained state, or continue new work in another qualified fresh session. The exported same-value writer is a programmatic controlled recovery primitive, not an operator CLI. Do not delete `.pending` merely to make the final readable.

新的 0.9.0 会话创建留下 .pending 时，本工具没有通用恢复命令。inspect 只接受已保留的 0.9.0 前来源，adopt 需要核验过的旧迁移收据，不能为新建会话编造旧收据。没有既有可信旧收据时，保持模式 unknown、诊断保留状态，或在另一合格新会话中继续新工作。导出的同值 writer 是程序受控恢复原语，不是操作者 CLI；不能为了让 final 可读而删除 .pending。

For rollback, stop writers, retain the receipt and bindings, and select the previous mode explicitly in each old profile before reinstalling the old Guard. A pre-0.9.0 Guard does not read these bindings; mixed-mode inventories need separate correctly mapped profiles or remain unsuitable for rollback. Keep host-lock and certificate identities separate: re-inspect the actual installed host as required, and never re-sign old certificates merely to change mode. Cross-machine transfer includes only verified bindings/receipts, with owner permissions restored; it transfers no host lock, credentials or native authority.

回退先停写者，保留收据与绑定，为旧 profile 显式选择原模式再恢复旧 Guard。0.9.0 之前的 Guard 不读取绑定，混合模式库存需正确映射的独立 profile，否则不适合回退。宿主锁及证书身份另行核验，不为改变模式重签旧证书；跨机仅迁移核验过的绑定与收据并恢复所有者权限，不转移宿主锁、凭据或原生权限。

## Storage capability limits / 存储能力边界

POSIX writes reuse the private writer lock, exclusive temporary creation, full write/file fsync, non-overwriting hard-link publication, directory fsync and final readback. Same identity/mode is a strict no-op preserving provenance. Readers reject malformed/duplicate-key JSON, bad digest/schema, unsafe owner/access modes, leaf links and user-owned ancestor links. Root-owned macOS `/var` and `/tmp` system aliases are the only permitted ancestor link exceptions; writable non-sticky ancestry refuses. These checks do not claim resistance to hostile same-owner processes racing the filesystem.

POSIX 复用私有 writer 锁、排他临时文件、完整写入及文件 fsync、不可覆盖 hard-link 发布、目录 fsync 与 final 回读。同身份同模式严格不改写来源。读取拒绝坏 JSON、重复键、摘要/schema 错误、错误所有者/权限、叶链接及用户祖先链接；仅允许 root 所有的 macOS 系统别名 /var、/tmp，非 sticky 可写祖先拒绝。它不是防御同 owner 恶意并发文件系统操作的绝对保证。

Windows uses the adopted **published-file flush barrier** on qualified local storage supporting same-volume hard links: flush the complete exclusive temporary, publish the non-overwriting link, open the existing final with read/write permissions without create/truncate, verify regular-file identity and exact bytes, fsync that final handle, close it and independently read back. No final bytes or permissions are normalized. Directory fsync remains an observed EPERM capability gap. Microsoft documents file data/metadata flush; applying that file flush to the newly published link is an explicitly bounded engineering inference, not POSIX-directory equivalence, power-loss proof, hardware-cache guarantees or durability of the whole ancestor namespace. Native candidate acceptance must record filesystem/runtime identity, this barrier and the directory gap separately.

Windows 在合格且支持同卷 hard-link 的本地存储上采用**发布后文件 flush 屏障**：完整排他临时文件 flush，不可覆盖 link 发布，以不创建/不截断的可写句柄打开现有 final，核对 regular-file 身份及精确字节，fsync 该句柄，关闭后独立回读。不规范化 final 字节或权限。目录 fsync 的 EPERM 能力缺口保留。Microsoft 说明文件数据/metadata flush；将其应用于刚发布的 link 是具名、有界工程推论，不是 POSIX 目录等价、断电、硬件缓存或整个祖先 namespace 持久性证明。候选原生验收须分别记录文件系统/runtime、文件屏障及目录缺口。

A post-publication failure retains the exclusive `.pending` temporary hard link; readers refuse `activation_publication_incomplete` even when final is visible. Controlled same-value writing reopens and successfully flushes retained temporary bytes, then can verify the exact pending/final identity, complete the barrier and remove the temporary. Recovery does not rewrite bytes or provenance. Temporary cleanup occurs after the required barrier/readback and its crash durability is a separate limit, not covered by that earlier flush. A malformed retained temporary or identity/mode conflict refuses automatic recovery. This is one per-session temporary publication, with no global transaction or birth WAL.

发布后失败保留排他的 .pending 临时 hard-link；即使 final 可见，读者仍拒绝未完成发布。受控同值写入须重新打开并成功 flush 保留临时字节，再核对 pending/final 精确身份、补完屏障并移除临时项，不改字节或来源。临时清理在必需屏障与回读之后，它的 crash 持久性独立，不能借用此前 flush。坏临时项或身份/模式冲突拒绝自动恢复；这是逐会话临时发布，无全局事务或 birth WAL。

The official file-tool guard denies explicit private-storage targets (including resolved path aliases), and shell-tool calls naming the private roots or mode entrypoint. Operator migration runs independently. This is bounded tool-surface protection, not arbitrary command interpretation, a general subprocess sandbox or protection against hostile in-process plugins/encoded shell commands. No broader host interception is claimed.

官方文件工具 guard 拒绝明确的私有目标（含解析后的路径别名），shell 工具拒绝指向私有根或模式入口的调用；操作者迁移独立执行。这是有界工具表面保护，不是任意命令解释、通用子进程 sandbox，也不防御同进程恶意插件或编码 shell 绕过，不声称更广的宿主拦截。
