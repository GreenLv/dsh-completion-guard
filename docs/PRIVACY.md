# Privacy

Context Guard stores only bounded, deterministic facts. It does not persist prompt or tool-output bodies.

## Stored

- Normalized clause text (single-line, whitespace-collapsed) and its SHA-256.
- Stable identifiers (R/A/P/E/C), revision, epoch, and event sequence references.
- Tool name, call/result seq, outcome enum, capability, subject, and surface.
- A bounded summary hash (truncated to 240 characters before hashing).

## Never stored

- Complete prompts, stdout, stderr, or file contents.
- Authorization headers, URL query values, credentials, or API keys.
- Image bytes or binary contents.
- Authenticated session state or raw transcripts.

## Failure behavior

- Unknown, failed, or object-mismatched evidence cannot certify completion.
- Without a durability checkpoint, evidence is recorded as `unknown`.
- Corrupt or unknown Guard state refuses certification rather than guessing.
