# Upstream API audit: DSH 0.1.7-rc.2

The current adapter targets only npm `0.1.7-rc.2`, upstream commit `477b4f420553e8a52c2fbccc464d7561b239c443`, and Cordis `4.0.4`. Planning inputs remain in [the evidence manifest](docs/dsh-0.1.7-rc.2-planning-evidence.json). This is source and local composition evidence, not acceptance of an installed Guard artifact.

## Published inputs and composition

`manifests/rc017-rc2-byte-audit.json` is the single source for 46 package identities, published tarball SHA-256, SRI, and executable/manifest SHA-256. The TypeScript registry imports those identities; tests require the shipped host manifest to agree exactly. Every recorded tgz was downloaded and its SHA-512 checked. Reproduce with `python scripts/verify_rc017_host_audit.py`: all 46 tarballs and 215 JavaScript/CommonJS/manifest files are checked without installation. Runtime inspection also checks reachable installed module bytes, contained real paths, unique instances and package entry metadata.

The isolated rc.2 CLI successfully composed both Web and Headless with `--profile <name> --dump-config`. Their dependency-free profile layers resolve through the actual runtime package map; the independent runtime's complete critical graph and module bytes passed inspection. Dumping config does not load Agents, prove a profile-local plugin graph or establish native acceptance. No daily Profile was modified.

The old 33-package assumption is removed. Additional critical inputs cover app boot and plugin ownership (`dsh-app-boot`, `dsh-plugin-manager`, `dsh-base`, `dsh-headless`), durable V4 restore (`dsh-session-persistence`, `dsh-session-persistence-jsonl`, `dsh-session-format-v3-to-v4`), Jobs, local shell execution and PTC. They participate in the trusted path rather than expanding the lock to every transitive dependency. Platform-native subprocess dependencies outside the recorded JavaScript inventory still require platform acceptance; this audit does not claim complete native-binary measurement.

## Adapter decisions

| Surface | Current consumer and decision | Evidence / limit |
| --- | --- | --- |
| Awaited `agent/created` | `src/runtime.ts` attaches once, retains disposers, enumerates existing Agents on enable, rolls back on failed initialization; no `whenIdle()` inside initialization | `tests/v080-rc017-lifecycle.test.ts`; Web reload still pending |
| Session V4 | Use `SESSION_FORMAT_VERSION` for header identity; preserve digest domain/fields and mirrored vectors | `tests/v080-rc017-session.test.ts`, real loop JSONL restore |
| Fork | `forked` is not a completed turn; child session identity remains separate | actual `buildForkSeed` test; no inherited completion claim |
| Message source | New Guard producers use the augmented `context-guard` kind. Historical Guard notices remain readable; developer/tool/scheduler/subagent messages cannot mint root authority | V4 source fixtures and existing recovery suite |
| Tool result | rc.2's flat ToolMessage requires matching `toolCallId`, tool source/callId, and `isError=false`; PTC retains its separate root/subcall association | structured-host-error and ordinary-observation families |
| Stop boundary | Guard notice contains a recomputed boundary digest and is flushed before use; no synthetic out-of-turn tool event | real AgentLoop persistence/restore regression |
| Jobs | `jobs.get(JobId(id), agent.id)` with exact `agent.id === agent.session.id` and returned id check | real JobsLocal same/foreign/unknown/deleted owner tests |
| Shell | Actual published bash/pwsh renderers; promotion and lossy output stay unknown, negative terminal facts cannot certify | renderer tests; promoted terminal target/readback chain remains unavailable |
| Default cwd | Call-time source, session, provider class and exact implementation bytes plus target containment | real isolated runtime provider checks; unknown remote providers rejected |
| Goal | Optional service and pinned tool; monotonic deny plus durable certificate gate remain | real Goal/ToolRuntime composition; exact native/model acceptance pending |
| Historical state | Preserve old ledger/certificates; changed host/session context does not automatically re-sign or reanchor | migration/recovery families; real migrated native session still pending |

## Existing synchronous reads

rc.2 still implements `snapshotEvents()` but marks new calls prohibited/deprecated. This adaptation retains existing synchronous use; it adds no history wrapper or promise of remote-history support. Production inventory:

- `src/domain/session-events.ts`: the existing shared entry validates array, contiguous sequence and event envelope.
- `src/runtime.ts`: durable projection and core/v2 projection from the current local Session.
- `src/domain/host-workdir.ts`: match the current persisted original call.
- `src/tools/observe.ts`: current-session observed call and target lineage.
- `src/tools/evidence.ts`: explicit resolution/effect/restart-intent matching.
- `src/raw-replay.ts`: bounded diagnostic snapshot and event inventory.

The host's persistence reader owns unknown required-event rejection before publishing a Session; Guard owns envelope validation. An independent whitelist would wrongly reject registered third-party event kinds. A damaged snapshot never falls back to an empty successful projection. Future asynchronous/remote history requires a separately scoped migration.

## Acceptance boundaries

CLI syntax was read from the exact published launcher and checked against its help/config output. Versioned native drivers retain their existing annex interface and await the real Agent factory. Synthetic adopted-release probes are explicitly mock registry controls, not real model or publication evidence. Restart, dual-platform lifecycle, full promoted-job completion, and old-session native migration remain subject to the [A01–A16 acceptance record](docs/DSH_0_1_7_RC2_ACCEPTANCE.md).
