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

For Headless, use its profile path and `--profile headless`. On Windows, use the
installed `.cmd` launcher and Windows absolute paths. A strict repeat leaves
the package and profile contents unchanged. Restarting or enabling a daily
profile remains a separate user action.

## What changes in the lock

The generator writes `hostLockPolicy: dsh-core/v1`, the actual runtime/profile
source roots, platform/profile kind and the complete 33-row core graph. The
core manifest is version 2. Runtime replay re-reads those graph sources and
requires the same exact core before using certificate authority.

An older injected configuration reports `host_lock_migration_required`.
Removing its market row by hand is not migration. Reinspect, inject and verify
the actual environment. Historical cohorts, requirements and session records
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
