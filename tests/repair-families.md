# Bounded repair bundles

Run `node tests/run-repair-families.mjs --list`, then choose one or more names:
`node tests/run-repair-families.mjs qualification target-identity`.
`all` runs their deduplicated union. Vitest reports the actual failing file,
case, assertion and stack; the command preserves failure or interruption.

| Family | Existing coverage and explicit limits |
| --- | --- |
| `qualification` | Governed clauses, descriptions and restatements; positive independent instructions; capture/derive, gate, prepare and registered tools. Includes the frozen round 34/35 probes. It is not proof for arbitrary natural language. |
| `target-identity` | Ordinary and restatement inputs; branch/refspec case, Chinese refspec, inline package version conflicts, version/profile/service alternatives; direct capture → log derive → gate and prepare. The explicit table is `domain/v063-target-family.test.ts`; narrowed-contract/core-alignment retain inheritance, action-plan and binding checks, and host-materialization covers registered tools. Rows are the declared risk matrix, not every possible entry/field cross-product. |
| `upgrade` | Recorded legacy projection, replay/idempotence, cross-end projection and host lifecycle unit paths. Does not establish live native profile recovery. |

Use these bundles after a family repair, together with its reproducer and a
bounded independent probe batch. Keep unknown/affected surfaces visible and
extend the corresponding table when a real counterexample exposes them.
Historical regressions remain in the full Vitest suite. These named bundles
are focused diagnosis, not replacement candidate, package, CI or native gates.
A successful process is evidence only for the source, tests and environment
actually exercised; retain the source identity in the existing review record.

Runner failure handling: `node --test tests/repair-families.node.mjs`.
