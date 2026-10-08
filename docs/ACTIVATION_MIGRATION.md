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

## Inspect, adopt, verify / 清点、采纳、核验

The entry `node /absolute/prepared-package/bin/dsh-completion-guard-activation.mjs` below uses the independently prepared 0.9.0 toolkit; it does not assume a new command is installed on PATH while the old Guard remains installed. The tool mounts only the official JSONL persistence service, without starting the agent loop, UI or model. `--runtime-anchor` is a file in the physical official runtime; the tool resolves its real path before loading dependencies. `--persistence-root` and optional `--compression none|zstd` must match the active persistence configuration. No storage path or encoding is guessed. Inspection uses public `list`, read-only `open`, exact header/inherited-cut metadata and revision readback; it outputs no event bodies. Keep writers stopped through the sequence.

下方使用独立准备的 0.9.0 工具入口 `node /absolute/prepared-package/bin/dsh-completion-guard-activation.mjs`，不假定旧 Guard 仍安装时新命令已在 PATH。工具只挂载官方 JSONL persistence 服务，不启动 agent loop、界面或模型。runtime anchor 必须是官方 runtime 中的文件，加载依赖前先解析物理路径。持久目录及可选压缩格式必须匹配实际配置，不推测目录或编码。清点使用公开 list、只读 open、精确 header/cut 元数据及 revision 回读，不输出事件正文。整个操作期间保持写者停止。

The following example is for a POSIX shell. Run `inspect` before replacement; run `adopt` and `verify` before starting the upgraded host. Keep the prepared toolkit path explicit throughout.

以下示例使用 POSIX shell：替换前执行 inspect，升级后的宿主启动前执行 adopt 和 verify，全程使用明确的候选工具路径。

```sh
node /absolute/prepared-package/bin/dsh-completion-guard-activation.mjs inspect \
  --runtime-anchor /path/to/runtime/package.json \
  --persistence-root /path/to/active-session-storage \
  --prior-modes /path/to/old-mode-source.json \
  --output /path/to/unused-frozen-migration.json

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
