# Historical finding: a prohibition was treated as a push obligation

A mixed instruction could be captured as a requirement to perform the very push it prohibited. An illustrative input is `修复代码，但不推送。`: fixing code is work, while the push clause constrains that work.

The current regression in `tests/domain/v051-instruction-semantics.test.ts` requires a push prohibition and no push obligation for this input. It also covers coordinated push/publication bans and the longer local-work instruction. `tests/domain/v051-clause-partition.test.ts` covers clause boundaries separately.

The repair interprets polarity and clause scope before deriving obligations. A prohibition never becomes an action merely because its text names a supported verb. Satisfying a completion checker must not require violating the instruction being checked.

This record retains the defect and its regression contract without raw session records, local paths or private ledger identifiers. Source regression evidence is distinct from installed-host and release acceptance.
