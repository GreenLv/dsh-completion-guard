# Isolated host composition fixture

This directory is a **standalone pnpm package** with its own `package.json`,
`pnpm-lock.yaml`, `pnpm-workspace.yaml` and `node_modules/`. It exists so that
Context Guard's integration tests can compose the real DSH 0.1.5-rc.1 host
packages — including `@deepseek-ai/dsh-agent-loop`, whose peers would otherwise
enter the repository root's lockfile and change the set of **critical package
identities** that `evaluateHostLock` reads.

Installing here must never touch the root dependency graph. The committed
`pnpm-lock.yaml` is the frozen reference; only `node_modules/` is generated:

```sh
cd tests/fixtures/host-composition
pnpm install --ignore-workspace --frozen-lockfile
```

Then run the composed suites from the repository root (they resolve this
directory's modules by relative path):

```sh
cd ../../..
env -u NODE_PATH npx vitest run tests/domain/v051-goal-lifecycle-composed.test.ts
```

`.npmrc` disables workspace linking and the shared lockfile, so the install is
confined to this directory. `node_modules/` is generated. The lockfile is versioned source and must remain unchanged during a frozen install.

Every version is pinned to the audited `0.1.5-rc.1` host set (Cordis `4.0.2`,
which is versioned independently). The fixture is a test dependency only: it is
not a product runtime dependency, it is never packaged, and it does not extend
the plugin's host certification range.

The fixture is NOT collected by the repository test runner: it holds no
`*.test.ts` of its own, and the composed suites live under `tests/domain/` and
resolve this directory's modules by relative path.
