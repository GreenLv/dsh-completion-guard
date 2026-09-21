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
