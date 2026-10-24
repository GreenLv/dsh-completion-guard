/**
 * vitest 4 starts pool workers with its own flags in `process.execArgv`
 * (`--require <vitest>/suppress-warnings.cjs`, dev `--conditions`). The
 * production host route audit correctly refuses to certify module routes in a
 * process started with custom require/loader hooks — in a real DSH host those
 * flags are absent. This setup file empties the harness's own execArgv before
 * any src module is imported, so the startup-conditions capture in
 * src/domain/host-node-conditions.ts sees the clean process these suites were
 * written against. Only the test process's in-place array is mutated; child
 * processes spawned by tests pass explicit argv and are unaffected. No
 * production code is changed.
 */
process.execArgv.length = 0
