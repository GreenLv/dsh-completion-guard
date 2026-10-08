# Privacy

Context Guard stores only bounded, deterministic facts. It does not persist prompt or tool-output bodies.

## Stored

- Normalized clause text (single-line, whitespace-collapsed) and its SHA-256.
- Stable identifiers (R/A/P/E/C), revision, epoch, and event sequence references.
- Tool name, call/result seq, outcome enum, capability, subject, and surface.
- A bounded summary hash (truncated to 240 characters before hashing).
- Provider-invisible private-ledger rows for explicit release reservations,
  settlements, and restart intents. They contain hashed Session/header/cwd/
  host/root bindings, release and target digests, bounded release readback
  identities, record positions, and a hash chain. POSIX files are owner-only;
  Windows uses the host account boundary and file flush supported by Node.

## Never stored

- Complete prompts, stdout, stderr, or file contents.
- Authorization headers, URL query values, credentials, or API keys.
- Image bytes or binary contents.
- Authenticated session state or raw transcripts.
- Raw Session IDs, local paths, prompts, command output, or credential values in
  the private ledger; those bindings are stored only as SHA-256 values.

## Failure behavior

- Unknown, failed, or object-mismatched evidence cannot certify completion.
- Without a durability checkpoint, evidence is recorded as `unknown`.
- Corrupt or unknown Guard state refuses certification rather than guessing.
- A missing ledger after its session anchor, a truncated or cross-session row,
  a conflicting contract/target binding, or an uncertain writer lock refuses
  release/restart reuse. Historical plugin notices are never promoted into the
  stronger private-ledger channel.

Session activation bindings store only immutable birth identity, mode and provenance digests in the private `activation-bindings-v1` directory. Migration receipts contain per-session identity/mode/cohort and relevant non-secret input digests, never raw prompt bodies or credential values. They are operator-owned integrity records, not signatures. Model file/shell protection has the bounded scope and platform gaps described in [activation migration](ACTIVATION_MIGRATION.md); arbitrary same-owner or in-process attackers are not excluded by checksums.

会话模式绑定只保存不可变出生身份、模式与来源摘要。迁移收据只含逐会话身份、模式、来源组及相关非秘密输入摘要，不含原始提示正文或凭据值。它们是操作者完整性记录，不是签名；工具保护及平台缺口见迁移说明，摘要不排除任意同 owner 或同进程攻击。
