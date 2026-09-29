# Upgrading the core host lock

Version 0.8.1 requires DSH `>=0.2.0-rc.1` and qualified Cordis `>=4.0.4`. Upgrade order and what each step produces:

1. Stop the host, upgrade DSH to `0.2.0-rc.1` or a later version, then install this Guard version.
2. Rebuild the host lock for each Guard profile by running `inspect`, `inject` and `verify-dump` from an accepted package or matching source checkout:
   `node bin/dsh-completion-guard-host-lock.mjs inject --runtime-root <DSH runtime> --profile-root <profile>` — then verify with `... verify-dump --dump-config <file>`. A successful rebuild reads back `supported` with `audit_provenance` stating how the graph was established.
3. Start each Web/Headless profile when needed so it reads the rebuilt lock. The checks above do not require a running host.

Failure readbacks distinguish these cases:

- `host_lock_migration_required`: the configuration lacks the policy or source roots. Supply `--runtime-root` and `--profile-root` when rebuilding the lock.
- `host_lock_version_below_minimum`: DSH is older than `0.2.0-rc.1`. Upgrade DSH first.
- `host_lock_version_mismatch`: the installed graph differs from the reviewed baseline in version or integrity. For a later compatible version, use `--rebind-registry` to acquire and qualify the published graph. For the baseline, restore the recorded identities.
- `host_lock_installed_graph_drift`: installed bytes or routes changed after the audit. Inspect the change before rebuilding the lock.

The floor is `>=0.2.0-rc.1` with no upper bound. Passing the version check does not establish native validation; validated versions are recorded separately. Guard's exact DSH core is separate from optional market versions.
A normal market update no longer changes the core digest. A plugin that changes
which core packages actually resolve still invalidates the lock.

## Upgrade an existing profile

Choose the published Guard package and DSH version from the
[compatibility guide](COMPATIBILITY.md). Keep the existing profile backup and
its disabled/activation settings. Installation does not authorize enablement.
Web and Headless are separate profiles and must be checked separately.

If the profile still declares `dsh-context-guard`, replace it through DSH's
plugin manager rather than loading both package names. Its internal
`context-guard` id remains unchanged. Preserve session files and user settings;
if a profile override names the old package, change only that package name.
Headless does not need market added as part of this migration.

After the new package is installed, use absolute paths for the actual runtime
and profile. The following example targets a POSIX shell:

```sh
DSH_RUNTIME_ROOT=/absolute/path/to/.dsh-runtime
DSH_PROFILE_ROOT=/absolute/path/to/.dsh/profiles/web
GUARD_HOST_LOCK="$DSH_PROFILE_ROOT/node_modules/.bin/dsh-completion-guard-host-lock"
"$GUARD_HOST_LOCK" inspect --runtime-root "$DSH_RUNTIME_ROOT" --profile-root "$DSH_PROFILE_ROOT"
"$GUARD_HOST_LOCK" inject --runtime-root "$DSH_RUNTIME_ROOT" --profile-root "$DSH_PROFILE_ROOT"
dsh --profile web --dump-config | "$GUARD_HOST_LOCK" verify-dump --runtime-root "$DSH_RUNTIME_ROOT" --profile-root "$DSH_PROFILE_ROOT" --dump-config -
```

**Run this block after the runtime is already on the target DSH version, not
before.** `inject` records the absolute runtime and profile roots and binds the
graph it finds there, and each session mount validates those same roots once,
with every security-sensitive entry validating them again at its own decision.
Injecting against the old runtime therefore writes a lock that describes a graph
the new runtime no longer has, and it will fail at the next mount or the next
protected entry. Order: stop the host, upgrade DSH and install Guard, inspect/inject/verify each profile, then start it when needed.

`inject` **writes to `<profile>/cordis.patch.yml`** — it replaces or adds Guard's
managed block in that file. Back the file up first. The same file is the one
`docs/LOCAL_ACCEPTANCE.md` tells you to preserve.

**Check both the JSON verdict and the exit status.** Accepted commands print `status: "supported"`. A missing graph, drift, incompatible implementation or untrusted registry description reports a specific `reason_code` on stderr and exits 1. `inspect-graph` is a pre-install graph check; it does not grant runtime authority.

For Headless, use its profile path for the host-lock commands and `dsh --profile headless --dump-config` for the dump. On Windows, use the
installed `.cmd` launcher and Windows absolute paths. A strict repeat leaves
the package and profile contents unchanged. Restarting or enabling a daily
profile remains a separate user action.

## Check a Headless profile before installation

A DSH Headless profile can have no external dependencies and no private `node_modules` or lockfile. From an accepted package or matching source checkout, `node bin/dsh-completion-guard-host-lock.mjs inspect-graph --runtime-root <runtime> --profile-root <profile>` checks that state without initializing or launching the profile.

This narrow case requires exactly the installation-owned `dsh-base` and `dsh-headless` bundles, a complete audited runtime core, and matching bundle versions, package-map origins and patch files. Declared but uninstalled dependencies, partial map/lock pairs, unexplained local modules and foreign parent-module fallbacks are rejected. Existing profiles with both graph files retain their active-importer checks; damaged files are not treated as an empty graph.

The result labels `inspection_scope: pre_install_target` and `profile_graph.state: dependency_free_headless`, with the manifest hash and bundle identities. Its package rows describe the verified runtime core used for this installation target, not a private profile importer or a live boot. After installing Guard, the `inspect`, `inject` and runtime replay checks still require the profile's package map, lockfile and installed plugin binding. This pre-install result cannot replace those checks.

## What changes in the lock

The generator writes `hostLockPolicy: dsh-core/v1`, the actual runtime/profile
source roots, platform/profile kind and the actual core package graph (46 rows in the reviewed baseline). The
core manifest is version 2. Each session mount validates those graph sources
exactly once; ordinary replay (resume, compaction, step and command refresh)
consumes that result without rescanning, and every entry that grants
certificate authority — completion certificates, mutation authorization,
release pre-effect decisions and Goal/Stop boundaries — validates the lock
freshly at the moment of its own decision.

Version 0.8.1 registers `dsh-0.2.0-rc.1-core-v1` as the audited baseline cohort and derives graph cohorts for compatible hosts above the version floor (see the compatibility guide). Runtime checks authenticate the mapped files and verify that each critical dependency resolves to the mapped instance. Installation imports use native Node resolution; Profile imports use the host's local-first routing and installation fallback only when no local package is selected. A nearer shadow, missing edge, wrong export target or escaped path is rejected even when the recorded versions match.

The manifest's `registry-derived-pending-native-audit` provenance and empty `auditedPlatforms` list describe its immutable source audit, which is part of the lock digest. Native acceptance belongs to each exact artifact's separate Release annexes; it does not rewrite that digest. Inspection, injection and dump verification report `audit_provenance` alongside the cohort and digest.

**Which failure code you see depends on the lock generation you are holding**, and
that matters for deciding whether you are migrating or just drifting:

- A **pre-0.4.3** lock — no `hostLockPolicy: dsh-core/v1`, or no recorded
  runtime/profile roots — reports `host_lock_migration_required`. Removing its
  market row by hand is not migration. Reinspect, inject and verify the actual
  environment.
- A **0.4.3-or-later** lock already carries the policy and the roots, so it never
  reports `host_lock_migration_required`. It reports the mismatch instead:
  `host_lock_version_mismatch` when the installed core package versions differ from
  the cohort, or `host_lock_installed_graph_drift` when the re-read graph resolves
  to a different digest than the lock recorded. Both are the expected answers after
  a DSH upgrade, and both are cured by re-running inspect, inject and verify against
  the new runtime rather than by editing the lock.

Historical requirements and session records are retained; old certificates do not become certificates for the new lock. Historical host cohorts are test data only and are not accepted by 0.8.1.
The shared digest-v3 encoder and its upstream fixtures are unchanged.

## Market and restart

Core compatibility does not certify the optional market restart adapter.
Market's current HTTP capability response and a matching disk manifest cannot
prove which provider bytes the service has loaded. Current DSH provides no
independent loaded-instance verifier, so this adapter remains unavailable.
An explicit restart requirement stays pending with a binding-unavailable
reason. Other guarded work continues; package apply proves disk state only.

A trusted embedding can supply a loaded-instance verifier to the version-2
service adapter. Its provider identity binds the actual version, integrity,
loaded tree, profile, origin and protocol. Its instance identity additionally
binds the process and boot. Only a persisted restart intent may connect the
expected old instance to a verified new instance of the same provider.
Provider replacement, arbitrary process drift and old version-1 credentials
cannot close that intent. These checks do not isolate a process from a
concurrently malicious process running as the same user.

## Acceptance records

Use the [native entrypoint](LOCAL_ACCEPTANCE.md) with explicit core targets
and a Web market version. Supplied daily target paths are read-only preflight
inputs. The driver creates its own isolated profiles, with no market in
Headless. Real market HTTP lifecycle checks and protocol unit fixtures are
separate from Guard adapter certification. Each native annex belongs to one
exact artifact and platform; publication is recorded on its GitHub Release.

## Historical 0.5.1 evidence

Version 0.5.1 registered DSH `0.1.5-rc.1` and `0.1.5-rc.2` with 33 critical packages. Its macOS and Windows results belong only to that artifact and those hosts; see the [0.5.1 release annexes](https://github.com/GreenLv/dsh-completion-guard/releases/tag/v0.5.1). These are historical records, not installation targets for 0.8.1.

## Rebinding compatible package versions

For a newer compatible installation, add `--rebind-registry` to `inspect-graph`, `inspect`, `inject` and `verify-dump` in the upgrade example above. This acquires the exact official archives and qualifies their consumed API contract. Changed programs run bounded probes in an isolated Node process; the command does not start DSH or install packages. A successful result binds a new lock. Keep the backup until dump verification succeeds.

The version floor admits later releases and RCs by SemVer precedence. A new version does not by itself prove that Guard can read its events or authorize its effects. Rebinding separates published installation identity from adapter qualification:

- Published identity is acquired from the official npm registry for each exact installed `name@version`. The registry integrity must agree with the installed lock, and the downloaded archive must reproduce that integrity. The archive supplies the manifest and module digests; local manifests and local lockfile SRI alone never establish provenance.
- Qualification is independent of version rows. Comments and formatting can retain the reviewed ECMAScript program; unrelated new modules are allowed. Changed programs must pass `guard-host-contract/v1` API and Session V4 behavior checks in a fresh Node process. These check immutable, contiguous event snapshots, restore preservation/refusal, fork recovery and unknown tool outcomes, plus consumed service APIs. A contract failure refuses the affected implementation. Optional Goal failures disable Goal integration while independent core work remains available.
- The probe uses verified archives and exact installed dependency identities in a temporary directory. It receives no user environment or credentials, cannot write files or launch child processes, and has its network entrypoints disabled. It has bounded time/output and does not boot a host, run installation scripts or contact model providers. This is a finite contract check of official code, not certification of every possible host behavior.
- The generator stores a deterministic qualification receipt under the declared profile's `.dsh-completion-guard/host-contracts/` directory and puts its binding in managed configuration. The receipt binds exact package/module bytes and Node startup conditions; a package compatibility declaration or a descriptor without its issued receipt cannot establish qualification. Pre-install `inspect-graph` uses the same qualifier and byte/route audit. Inspection and authorization recheck the mixed-version graph, qualified bytes and both CJS/ESM routes in one fresh audit session; they do not repeat the behavioral probes.
- Route checks use actual startup conditions from command-line flags and `NODE_OPTIONS`, including custom conditions, disabled addons and `module-sync` availability. Changing these inputs creates a new binding. Custom loaders or ambiguous configuration are refused rather than approximated.
- A changed graph or trust description creates a new lock identity. Existing completion certificates and private authority records retain their old digest and cannot transfer. Reinject the lock, restart the profile under the user's control, and obtain new evidence.

Rebinding writes only its qualification receipt and, for `inject`, the managed lock configuration. It does not start DSH, install packages, publish, or mutate session history. Foreground/default-workdir interpretations retain their narrower reviewed-byte qualification. Native acceptance of a later DSH version remains separate from this source-level compatibility rule.
