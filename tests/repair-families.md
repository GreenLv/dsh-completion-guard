# Bounded repair bundles

Run `node tests/run-repair-families.mjs --list`, then choose one or more names:
`node tests/run-repair-families.mjs qualification target-identity`.
`all` runs their deduplicated union. Vitest reports the actual failing file,
case, assertion and stack; the command preserves failure or interruption.

| Family | Existing coverage and explicit limits |
| --- | --- |
| `qualification` | Governed clauses, descriptions and restatements; positive independent instructions; capture/derive, gate, prepare and registered tools. Includes the frozen round 34/35 probes. It is not proof for arbitrary natural language. |
| `target-identity` | Ordinary and restatement inputs; branch/refspec case, Chinese refspec, inline package version conflicts, version/profile/service alternatives; direct capture → log derive → gate and prepare. The explicit table is `domain/v063-target-family.test.ts`; narrowed-contract/core-alignment retain inheritance, action-plan and binding checks, and host-materialization covers registered tools. Rows are the declared risk matrix, not every possible entry/field cross-product. |
| `upgrade` | Recorded legacy projection, replay/idempotence, cross-end projection and host lifecycle unit paths. Includes the v6 recovery-feedback matrix (`tests/v6-recovery-feedback.test.ts`): the recovery packet, digest, trigger title and registered pre-step injection consume the same confirmed core-v2 view as prepare/checkpoint, with the historical strict lanes pinned unchanged. Does not establish live native profile recovery. |

Use these bundles after a family repair, together with its reproducer and a
bounded independent probe batch. Keep unknown/affected surfaces visible and
extend the corresponding table when a real counterexample exposes them.
Historical regressions remain in the full Vitest suite. These named bundles
are focused diagnosis, not replacement candidate, package, CI or native gates.
A successful process is evidence only for the source, tests and environment
actually exercised; retain the source identity in the existing review record.

Runner failure handling: `node --test tests/repair-families.node.mjs`.

## rc017-adaptation

Runs rc.2 identity, lifecycle, V4, renderer, Jobs, default-workdir, Goal and recovery composition tests. Set `DSH_RUNTIME_ROOT` to an isolated rc.2 installation for the real graph/module and provider tests; these are explicitly skipped when absent. Renderer tests invoke published tool producers with controlled shell results. They do not establish real native shell, Web restart, exact-artifact or model acceptance.

### rc017 dependency-route identity family

Invariant: authenticated package-map files are insufficient unless the importer's actual critical dependency path reaches that same package. The family covers installation native resolution, profile-local priority and profile-to-installation interception, normal pnpm symlinks, missing/redirected map edges, unlisted nearer shadows, duplicate reachable critical identities, exported subpaths and escaping symlinks. Critical package exports are authenticated before using Node require resolution: rc.2 uses the same default target for ESM/CJS and any new conditional branch is refused. The real-runtime test also invokes the unmodified official rc.2 worker loader and checks both ESM and CJS profile resolution.

Portable synthetic route cases run without an installed DSH runtime. The full 46-package byte/map/shadow control and official loader probe require `DSH_RUNTIME_ROOT`; their skips are explicit. These are dependency-route checks, not live Web restart, native-artifact or real-model acceptance. Noncritical implementation bytes and concurrent same-user filesystem replacement remain outside this byte audit.
