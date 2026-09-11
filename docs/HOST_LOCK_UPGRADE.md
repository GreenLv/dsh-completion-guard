# Upgrading the core host lock

The 0.4.3 line separates Guard's exact DSH core from optional market versions.
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
graph it finds there, and runtime replay re-reads those same roots. Injecting
against the old runtime therefore writes a lock that describes a graph the new
runtime no longer has, and it will fail on the next replay. Order: upgrade the
runtime, restart it, then inspect/inject/verify.

`inject` **writes to `<profile>/cordis.patch.yml`** — it replaces or adds Guard's
managed block in that file. Back the file up first. The same file is the one
`docs/LOCAL_ACCEPTANCE.md` tells you to preserve.

**Read the verdict from the JSON body, not from the exit status.** All three
commands print a JSON object whose `status` is the verdict — `supported`,
`unsupported` or `unavailable` — together with `cohort_id`, `host_lock_digest` and
`audit_provenance`. Note that `inspect`, `inject` and `verify-dump` exit **0** even
when that status is `unsupported`; only `inspect-graph` exits non-zero on an
unsupported graph, and only a thrown error produces `status: "unavailable"` with a
`reason_code` on stderr and exit 1. So a shell check of `$?` alone will not tell
you whether the graph was accepted.

For Headless, use its profile path and `--profile headless`. On Windows, use the
installed `.cmd` launcher and Windows absolute paths. The published 0.5.1 artifact passed separate native macOS and Windows acceptance on DSH `0.1.5-rc.2`; see the [acceptance record](LOCAL_ACCEPTANCE.md). That result does not cover other artifacts or host versions. A strict repeat leaves
the package and profile contents unchanged. Restarting or enabling a daily
profile remains a separate user action.

## Check a Headless profile before installation

A DSH `0.1.5-rc.1` Headless profile can have no external dependencies and no private `node_modules` or lockfile. From an accepted package or matching source checkout, `node bin/dsh-completion-guard-host-lock.mjs inspect-graph --runtime-root <runtime> --profile-root <profile>` checks that state without initializing or launching the profile.

This narrow case requires exactly the installation-owned `dsh-base` and `dsh-headless` bundles, a complete audited runtime core, and matching bundle versions, package-map origins and patch files. Declared but uninstalled dependencies, partial map/lock pairs, unexplained local modules and foreign parent-module fallbacks are rejected. Existing profiles with both graph files retain their active-importer checks; damaged files are not treated as an empty graph.

The result labels `inspection_scope: pre_install_target` and `profile_graph.state: dependency_free_headless`, with the manifest hash and bundle identities. Its package rows describe the verified runtime core used for this installation target, not a private profile importer or a live boot. After installing Guard, the `inspect`, `inject` and runtime replay checks still require the profile's package map, lockfile and installed plugin binding. This pre-install result cannot replace those checks.

## What changes in the lock

The generator writes `hostLockPolicy: dsh-core/v1`, the actual runtime/profile
source roots, platform/profile kind and the complete 33-row core graph. The
core manifest is version 2. Runtime replay re-reads those graph sources and
requires the same exact core before using certificate authority.

Version 0.5.1 registers separate DSH `0.1.5-rc.1` and `0.1.5-rc.2` core graphs. Their package identities come from exact published npm tarballs. The immutable package records `auditProvenance: registry-derived-pending-native-audit` and an empty `auditedPlatforms` list; this provenance is part of the lock digest.

The later macOS and Windows native runs on rc.2 are recorded in the [0.5.1 release annexes](https://github.com/GreenLv/dsh-completion-guard/releases/tag/v0.5.1). They establish native acceptance for that artifact and host version without modifying its registry or digest. A lock readback by itself proves the registered graph match, not a native run. Successful inspection, injection and dump verification report `audit_provenance` alongside the cohort and digest; a failed check reports only its status and reason.

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

Historical cohorts, requirements and session records
are retained; old certificates do not become certificates for the new lock.
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
