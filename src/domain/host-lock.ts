import { createHash } from 'node:crypto'
import { hostLockDigest, type CapabilityRow, type PackageRow } from './digest.js'
import { SEMANTIC_ACTIONS, type SemanticAction } from './protocol-manifest.js'
import { ALPHA3_HOST_PACKAGES } from './alpha3-host.js'
import { RC1_HOST_PACKAGES } from './rc1-host.js'

export type HostLockStatus = 'supported' | 'unsupported' | 'unavailable'
export type HostPlatform = 'posix' | 'windows'
export type HostProfileKind = 'headless' | 'web'

/**
 * Capability expectations shared by every audited host cohort. The rc.1 audit
 * found one host API change: Session event reads moved from `events` to
 * `snapshotEvents()`. Guard adapts that API locally while the event vocabulary,
 * flush contract, Goal disarm, `update_goal` gating, tool definition, and
 * renderer terminal markers remain compatible.
 */
const AUDITED_CAPABILITY_ROWS: readonly CapabilityRow[] = [
  { name: 'goal_complete_precommit_guard', value: { k: 's', v: 'required' } },
  { name: 'goal_disarm_readback', value: { k: 's', v: 'required' } },
  { name: 'session_flush_before_control', value: { k: 's', v: 'required' } },
  { name: 'tool_guard_monotonic', value: { k: 's', v: 'required' } },
  { name: 'host_capability_model', value: { k: 's', v: 'action-platform-v1' } },
  { name: 'external_wait_jobs_readback', value: { k: 's', v: 'dsh.jobs.v1' } },
  { name: 'filesystem_tool_contract', value: { k: 's', v: 'dsh.fs-tools.v1' } },
  ...SEMANTIC_ACTIONS.map((action) => ({ name: 'supported_action', value: { k: 's' as const, v: action } })),
]

export interface HostCohort {
  /** Stable cohort identity; bound into every hostLockDigest via `host_cohort`. */
  id: string
  manifestVersion: number
  supportedGoalVersions: string[]
  /**
   * Platforms where this cohort's exact package graph was extracted from a
   * native host and audited. Other platforms fail closed; integrity must not
   * be inferred across platforms.
   */
  auditedPlatforms: readonly HostPlatform[]
  packages: PackageRow[]
  capabilities: CapabilityRow[]
}

function defineCohort(
  id: string,
  supportedGoalVersions: string[],
  auditedPlatforms: readonly HostPlatform[],
  packages: PackageRow[],
): HostCohort {
  return {
    id,
    manifestVersion: 1,
    supportedGoalVersions,
    auditedPlatforms,
    packages,
    capabilities: [
      { name: 'host_cohort', value: { k: 's', v: id } },
      ...AUDITED_CAPABILITY_ROWS,
    ],
  }
}

/**
 * alpha.2 audited package identities (second registry cohort), hoisted so the
 * alpha.2 + dshmarket 1.39.0 cohort can reuse the exact natively audited rows
 * with only the dshmarket identity substituted.
 */
export const ALPHA2_HOST_PACKAGES: PackageRow[] = [
  { name: "@deepseek-ai/cordis", version: "4.0.2", integrity: "sha512-asOnXP1TzFSFQlHb1iegDZp0z/8WD1c7YNrwJR/Tx2bzNuMXfcekE/I67Iv6SQXeLB4csxqCngzQKANP7gdw0g==" },
  { name: "@deepseek-ai/dsh", version: "0.1.2-alpha.2", integrity: "sha512-4TvTC5kRKlgtSU2UTBv+cID9a2Z+6+m6mpvjXWJfVzuTkflCff6s4MsQpFJTCmwFh/k7zNWe7qFXcLYMV/5VvA==" },
  { name: "@deepseek-ai/dsh-agent", version: "0.1.2-alpha.2", integrity: "sha512-K7B5XSQ7byB/IoNGj7n+lBgHCpVPJqEPvpGoHKc1dBS8fPo2yYp/ALFag4YOfrXVP3jQ9A8di20BbvIlp79SoA==" },
  { name: "@deepseek-ai/dsh-agent-loop", version: "0.1.2-alpha.2", integrity: "sha512-UU1i+rTuQV3Q5PGY4qFlojJ0Gbthib22pida5elZlg28dd8gtY2d1U5V9q2+rKK/469CO29rkz6TWMWk0g93Jg==" },
  { name: "@deepseek-ai/dsh-attachment", version: "0.1.2-alpha.2", integrity: "sha512-+e+zQCbBi94Jnyfpq/M+/J2R/66GbMh5zqr7yVdCjvAJp8d2hxQsZ0O/oaSV+iZQIMgJz+BcwvrS1VU+XmzQWg==" },
  { name: "@deepseek-ai/dsh-bash-sandbox", version: "0.1.2-alpha.2", integrity: "sha512-y5NZT7OkKi23N2fF+x9oo1QZH8LPfTU+llL86r+iETSSk5jzh91Hp2cP5Iq5S/L3BAQDaEw2J4Dg8VjF+fnnkg==" },
  { name: "@deepseek-ai/dsh-commands", version: "0.1.2-alpha.2", integrity: "sha512-KkyNkD5V80h+xXsByGdXH8uvKo/5uflb1CSY8O8IrciuptaJdneSAmTFsjmCKAjqCTGgigk2VDw6mqPwux2JYg==" },
  { name: "@deepseek-ai/dsh-fs", version: "0.1.2-alpha.2", integrity: "sha512-wx5n0QS5rfZ2LPVocMNfuOUh0RYH/QuLoCEy+qI8U3nKmSZ8GSTASURLg+0pVxckHpLElo38U+S/lkLxRK1rpQ==" },
  { name: "@deepseek-ai/dsh-fs-local", version: "0.1.2-alpha.2", integrity: "sha512-IIpZAxGw8wr+xpZQhvuHB9JtUeE6V03e45njfFah1eRl0miaHV5CxCRlFwkMLrow5I2zCCsCPPmdEaouGxTGSA==" },
  { name: "@deepseek-ai/dsh-fs-observation-policy", version: "0.1.2-alpha.2", integrity: "sha512-oMDSB1NTnj4rIGy5JXCtbzTFDwKkU/38KIKrVs3u6b65Y5spq3kjc1ITpjqo3Ze4H8umc8wJqGke2o/ms8eIEQ==" },
  { name: "@deepseek-ai/dsh-fs-sandbox", version: "0.1.2-alpha.2", integrity: "sha512-jTnGZUov95e9OANKG+uoWAczdGlzy24aXJ+z4N4J+rMvThfj5awV3ucsmX9S4YW2peHoTV9D7BNGgBQ84LxB+w==" },
  { name: "@deepseek-ai/dsh-goal", version: "0.1.2-alpha.2", integrity: "sha512-6E+QfBezGsQ2RI0KLZc8llRpukV9ujLjCcQ2UAboYJS7FPQMs7f/QfSrfTubwpB4lrnOok0H26JT2jHUhJeQbQ==" },
  { name: "@deepseek-ai/dsh-host-plugin-inventory", version: "0.1.2-alpha.2", integrity: "sha512-qWD+fTYTq8YoNa1TbYXy/Qk7bjjS4URJMgMa3m1vnyZ+xdwtRBF47dUa7wVAVX7oGg03bl7TD1Eo7GcKP/eajA==" },
  { name: "@deepseek-ai/dsh-host-webserver", version: "0.1.2-alpha.2", integrity: "sha512-cvsfM/cm5hZk/RqdIsardfqBIVpemdmUrP4M6UgdqhJy2nG5VnokLBg7k0bc8Yi11q0vIETfQK4xiDOSOMnu7Q==" },
  { name: "@deepseek-ai/dsh-jobs", version: "0.1.2-alpha.2", integrity: "sha512-yPNlYX/ZKphjzRY7oMf5uLgfSlJ8qBp49W6qNqzhmn8moXgJcPUCNqeOkT0C3a6GQ286mmmo09eyfDLGX7+lMQ==" },
  { name: "@deepseek-ai/dsh-jobs-local", version: "0.1.2-alpha.2", integrity: "sha512-nrK4ujL6QRS6GAysgBR08vaHub4vh7/iuGtmMvcg4Bp3hZeQ4rjWnpQAuItg9E9G3OUrvfjwzwENEM1TyVcbWw==" },
  { name: "@deepseek-ai/dsh-llm", version: "0.1.2-alpha.2", integrity: "sha512-ip6yMxwHugxQm4VCbwX/FDnlTeeBM9VBkIn0+74ityQy7Z3yKREJ1Ov8Z04l4G3duRzeGRsQ4ztOFZ01oNfKIw==" },
  { name: "@deepseek-ai/dsh-pwsh-sandbox", version: "0.1.2-alpha.2", integrity: "sha512-j/gUmv+nWYzg8o+oEEIK9FKeb6L24n2u7xjpIm7DcL5YjQlRDR6FgDvR2hpUK/d4Wk+zvnaPqZaEaXfUtOzEKQ==" },
  { name: "@deepseek-ai/dsh-sandbox", version: "0.1.2-alpha.2", integrity: "sha512-InfHYn5B0MxF5QLz0AjbwPS5W0G9VtIvjEFl5o/049KzH6khGKhjqOAVZtu1Z46f1+K/dbjF50VkTdnX3pgIJA==" },
  { name: "@deepseek-ai/dsh-sandbox-policy", version: "0.1.2-alpha.2", integrity: "sha512-Af7DWZTEjF/70YWSiN0jfbZli1XRk6Bo9W61QHxfShS79I8//mOPrItEPtJRWL/RCmGNfudFglNFyyGKdaqBIg==" },
  { name: "@deepseek-ai/dsh-session", version: "0.1.2-alpha.2", integrity: "sha512-RfikXscYTDXDr7CD7C/8oGJZaH8Egclj7pmXRtd90QcB5L8RIQ7069xrHZjds8OjNrFo69qQwNK3gYLUVZy9PA==" },
  { name: "@deepseek-ai/dsh-shell", version: "0.1.2-alpha.2", integrity: "sha512-i16e+OrCJ7GZ1XDnPds081NgVs/xzIVMLECzmLnXgVDKeePgWpdEgR//PgMqKPwoBoJ8z7DTzwKiOISAtOpNzA==" },
  { name: "@deepseek-ai/dsh-shell-env", version: "0.1.2-alpha.2", integrity: "sha512-OCf1iaPC5Qg6/DMLzvq5flGVSKP2uxAhgKs+8vrRuUiKc2UXXUE4uKayzZU7S18EysLZOVjMKKyUnHFXCVRQxg==" },
  { name: "@deepseek-ai/dsh-subprocess-local", version: "0.1.2-alpha.2", integrity: "sha512-IFneyTRqvbF/1Jm9h0WwBBxwlAd3vRh3SE/sZo2DTy9lzkRUMEBmWTiJZhVCMZ7hDLE0ALnjLLnLFLkA7bCP9Q==" },
  { name: "@deepseek-ai/dsh-system-prompt", version: "0.1.2-alpha.2", integrity: "sha512-qT9PZEVMAbszsg1UVUvuovfWFS5unjy08KV0rnOc89TJCgkb2CnlknSyIQs0lXc/UiqT6ZQ59i4ClAFrXhxfxQ==" },
  { name: "@deepseek-ai/dsh-tool-bash", version: "0.1.2-alpha.2", integrity: "sha512-Vt70FCPSE3Y7++2i9dKCNrsXTqhDpeJwqo44/GZow1xJ5acY9iNkjmjfq0UrTvacLLOEVnrMMBa9LojXi2WZUA==" },
  { name: "@deepseek-ai/dsh-tool-fs", version: "0.1.2-alpha.2", integrity: "sha512-zQ+zxunJ9BXFR/kAw0Z/LO5TEy87uf1X2giE1AmM9fqbev28vd4pzLq3y8F9b0E64461ANrfD1q2wx8Gy1w47g==" },
  { name: "@deepseek-ai/dsh-tool-goal", version: "0.1.2-alpha.2", integrity: "sha512-lvp60s3JKuTzncrlKCyS3qM/jYMLZSTMXJ/xQ8A0EIDvfPp7x1C3NNez66IJXPJ5YMtW9QYsqx2YmnUKhPOrow==" },
  { name: "@deepseek-ai/dsh-tool-jobs", version: "0.1.2-alpha.2", integrity: "sha512-QYq4almnoKNDu/ncrpGLTfkT5sIdqvRTyLd61VNJTFl4rNT2G/JCoEIhDgf50Rkwcchvvk/bNNdekjlENqZjKg==" },
  { name: "@deepseek-ai/dsh-tool-pwsh", version: "0.1.2-alpha.2", integrity: "sha512-sRGAmLWxxb+gglsqoftLojnFY1HaKMcwV9itkvv7JeACn5vkZuXTI0I/gNxjvt+g/b6sXT37hmQ7bmyo3dFHuQ==" },
  { name: "@deepseek-ai/dsh-tools", version: "0.1.2-alpha.2", integrity: "sha512-trk0fkmCDp64pqdcr8u7rCcRrwNi+93FKuznTnCD+YsPGFygcSG/6n+Wsh4+9A6oI1fM4/Ecq6Baa9vq1sNhJg==" },
  { name: "@deepseek-ai/dsh-user-approval", version: "0.1.2-alpha.2", integrity: "sha512-CcV3hf2Q0NYxRbnlE+IysaUkq/hvmjlvS9OGiHpARZVY4VlidlZRmsy5g5L17vDoxirX+WBJ9Cc5VcJMcjPrUg==" },
  { name: "@deepseek-ai/dsh-web-app", version: "0.1.2-alpha.2", integrity: "sha512-+SKilM9fCCCoYr3fKT7CxNiozGsNHgvvTGhL63tKXM7/3M96dyj7zhT5ztoTgIDW9b9m8J/CaJUa4KlSeUJGFQ==" },
  { name: "dshmarket", version: "1.38.1", integrity: "sha512-Z9VleLtCXwk5OlbSJKayWtbMaKACL8JUMyb/JHpErS4N3q//GJS+cgOhhxNkZYmXxB8/lv9IbhX1CBzlMhJeJg==" },
]

/**
 * The exact graph the Windows daily runtime realized when it upgraded
 * dshmarket to 1.39.0 on an otherwise alpha.2 install — the combination whose
 * rejection was Guard 0.3.2's real web_control failure. It is one audited
 * whole-graph cohort: alpha.2 rows keep their native macOS/Windows audit
 * identities and the dshmarket 1.39.0 identity is the authoritative row from
 * the 2026-09-01 alpha.3 annex audit. Guard 0.4.0 supports this combination.
 */
export const ALPHA2_DSHMARKET_139_HOST_PACKAGES: PackageRow[] = ALPHA2_HOST_PACKAGES.map((row) =>
  row.name === 'dshmarket'
    ? { name: 'dshmarket', version: '1.39.0', integrity: ALPHA3_HOST_PACKAGES.find((entry) => entry.name === 'dshmarket')!.integrity }
    : row)

/**
 * Audited host cohort registry. The rc.2 cohort keeps the exact identities
 * audited for 0.3.0/0.3.1 on macOS and Windows. The alpha.2 cohort carries the
 * exact package graph extracted from native macOS and Windows DSH
 * `0.1.2-alpha.2` / dshmarket `1.38.1` runtimes. The alpha.2+dshmarket-1.39.0
 * cohort carries the exact upgraded-Windows graph. The alpha.3 cohort carries
 * the graph audited in the 2026-09-01 annex. The rc.1 cohort carries the exact
 * runtime plus dshmarket 1.41.0 graph audited natively on macOS, then confirmed
 * on Windows: the 2026-09-04 native Windows rc.1 runtime graph (dshmarket
 * 1.41.0) was extracted from the runtime lockfile and verified row-for-row
 * identical (name, version, registry integrity) to the posix extraction before
 * this cohort was widened. Graphs that mix cohorts, lack
 * rows, duplicate rows, or use identities outside every registered cohort
 * fail closed.
 */
export const HOST_COHORTS: readonly HostCohort[] = [
  defineCohort('dsh-0.1.1-rc.2', ['0.1.1-rc.2'], ['posix', 'windows'], [
    { name: '@deepseek-ai/cordis', version: '4.0.1', integrity: 'sha512-YBdskTU2Po1kru3GgcUWUbkTsPMA9LkSQDAY8rBkFJeajdgcQad3QPJZE26JyK99Xb6HaASvoXg2DSUTeN/0Nw==' },
    { name: '@deepseek-ai/dsh-agent', version: '0.1.1-rc.2', integrity: 'sha512-cC7lnJe7JgPFcreNXxcxLMxQd78LnpVO9ZXROjZsGRQN1zGH6i/DduI892F1am85IfzzO+XTxMwwUHmfwamb0g==' },
    { name: '@deepseek-ai/dsh-commands', version: '0.1.1-rc.2', integrity: 'sha512-BOIe4Sht9rmMv1a6b3GWjWBbeWr7PtHlAy41vgpaymvUUuzOapOIA648ZMGCI/crRIt72Umev2FHtSwCNSbYZg==' },
    { name: '@deepseek-ai/dsh-goal', version: '0.1.1-rc.2', integrity: 'sha512-lSHTh4vfS6eRb9to/y+bjRf2+0QkNpY3tHJ29HMTewR9fJYZsEVVu4Hc+GPhPEjF7RpiD35/sKx+akijtDasyg==' },
    { name: '@deepseek-ai/dsh-llm', version: '0.1.1-rc.2', integrity: 'sha512-ASJfjIdZbIXvLwi3rGo+eZb/GxMVV/WO5/XVD3B96mT8EIzrlw3+nMR6/CvmJVzcycKQ2XN0wj7jD6TasPRySA==' },
    { name: '@deepseek-ai/dsh-session', version: '0.1.1-rc.2', integrity: 'sha512-4/cv6X9HPhm47eyRhCu/WZwzrtJKegk5J+0xaxcZ9i8S0smdxP57tqy8a0jkSshLQn7BzMFxneQrlYExrLrDhQ==' },
    { name: '@deepseek-ai/dsh-tools', version: '0.1.1-rc.2', integrity: 'sha512-0GGL4D55MwYDepzZMOI3L0ycu5b2qr96GL0Y7snwhAnpK2Di61rbX3fJE+PB3ZrovGX0csIRdt9n3iJZDVtDrw==' },
    { name: '@deepseek-ai/dsh-tool-goal', version: '0.1.1-rc.2', integrity: 'sha512-kTECpE732uwlxRJr/jBZb1BqaxZzrA7Rv4KuM3eolvhoTJ5zjyiR2YHmDmCSfuI6zmA/BEfWss7D0mLbVtJEZA==' },
    { name: '@deepseek-ai/dsh-agent-loop', version: '0.1.1-rc.2', integrity: 'sha512-2uJZ6kjJ3IYLRGn6/NhiZgD576ABcbERB/nkReR9TEUMO2zWkz6OuKtVwLyFCFSni2T25Jv+clKQWt7D4MhU3A==' },
    { name: '@deepseek-ai/dsh-tool-bash', version: '0.1.1-rc.2', integrity: 'sha512-YNmrKmBanj5EQn1zejjbo4UUFtg2/h3s9y0lY3vBu+dezNz4HdUlSkSZACbNUAZywyLomdhlt4rJdtdnrqyS7Q==' },
    { name: '@deepseek-ai/dsh-tool-pwsh', version: '0.1.1-rc.2', integrity: 'sha512-Gr0F4VWCIIR25qWVv4mMEJnewXILHLCkZwrLfbHA2OOI7DNvvdB5wjJxhuo+ZQa8/3KJ/byQGtEBqCY9mb10Zg==' },
    { name: '@deepseek-ai/dsh-shell', version: '0.1.1-rc.2', integrity: 'sha512-gEqPUxKOpOV66wvM4o8Z5FEuWmsEvYzD9OQy3cyo/kjzlx+2+KUWi22cl/YWtBs/zUtRJbdG5UqMnh8GUeO8Hg==' },
    { name: '@deepseek-ai/dsh-subprocess-local', version: '0.1.1-rc.2', integrity: 'sha512-I4pyzpohZEVRQQbuEpMP0t8oKsf+XIlRo64aJVKGXI2eMcg9f9gbfhKQNYNqRGbegQL1HYpSLU6Rzyibldgwaw==' },
    { name: '@deepseek-ai/dsh-bash-sandbox', version: '0.1.1-rc.2', integrity: 'sha512-bagZDMZ73C1dVDBjFCn1flNZ8aOEel4dsmDJTfmagqeYPXfIJDFKPhDc3lWjc+o6jMNfmumeUJ62dwhHkjJHKA==' },
    { name: '@deepseek-ai/dsh-pwsh-sandbox', version: '0.1.1-rc.2', integrity: 'sha512-hBUTg5p8TTQifZrfstbimVlBFyUOb7JhNkWKc+n6UpTzoFRSkPAvrjGeXKDmFI6jXpL4nXzLJoaIssfYnRg7bw==' },
    { name: '@deepseek-ai/dsh-shell-env', version: '0.1.1-rc.2', integrity: 'sha512-dDKKqsxsbklUpxX5ornd/SKJ2yfr/SOHOWDgeJkYvx3SMSXq8EvhCK/VEvHswXQ25rRLFWM4/Mr3htk1hn/GPA==' },
    { name: '@deepseek-ai/dsh', version: '0.1.1-rc.2', integrity: 'sha512-UP1UIh6q3Gme/yXRn/QL2P8IsVlv8Shpg22TRJIZPsCRWLm4CBiA1MUvXmJAfsOEETBMLAl+xWPtFw6ICsN3wg==' },
    { name: '@deepseek-ai/dsh-host-plugin-inventory', version: '0.1.1-rc.2', integrity: 'sha512-Hud9ezW0bexWfhX7C+c5rdUDX1xzbEGDzj1lGQyj/QxdrxHYHjGrJq3tLRyvN6K4FSmEdG2IBKdQGCOLVrIthA==' },
    { name: 'dshmarket', version: '1.36.0', integrity: 'sha512-xX8CCoXdIALaxtLosj+5qGg8r1cykW2zo1AOPJcSQepg2r4Vd2K0NmERldDqfeyFV0pCuZsUoAPe1Q/BW7De/g==' },
    { name: '@deepseek-ai/dsh-host-webserver', version: '0.1.1-rc.2', integrity: 'sha512-t9MrjC65QHiiWhG9V8UZxgfE/aWYhJHHrIM0kbTvtXxg4tLGIKo/upHp7iiag65F3HTkVLrH/DUyPMi4v2ZA7g==' },
    { name: '@deepseek-ai/dsh-web-app', version: '0.1.1-rc.2', integrity: 'sha512-1zGHY7qwBVlVJrzIWu+86SuBZXaVUxe2JRfffsuRvKXq2QcR/K4CoJJfZ43cDoWKu9xPvvxz7w2ezV+EdXgg1A==' },
    { name: '@deepseek-ai/dsh-jobs', version: '0.1.1-rc.2', integrity: 'sha512-SXvDJMvcUrGrlzIyE7j8/lI4Pj1nDe/UOR8C05Zagp+/0R8p46n6KylySvZdPAFENV5t8WX3Fw3eOaS4No0+wQ==' },
    { name: '@deepseek-ai/dsh-jobs-local', version: '0.1.1-rc.2', integrity: 'sha512-26lg7mi9RKnu8IP8SWLbY+uZenbqF2AkAZvgZaLDlw1z58NtBsbgKgh6FNC8JXEyknAwYc6auQQKF+nLTlEjCw==' },
    { name: '@deepseek-ai/dsh-tool-jobs', version: '0.1.1-rc.2', integrity: 'sha512-wCU7mo2uoQcAtz7de4ZXP2es9lALsmz6XzC+KAlS2e7/yTBi9a5LL2vdSr6XhExVAuhu/6f9eM/w4EQBOxtKlw==' },
    { name: '@deepseek-ai/dsh-tool-fs', version: '0.1.1-rc.2', integrity: 'sha512-llX8AWbaI3CGme/a2eeTSfy5atk8u3iJeOFzmZV/KZ0v0hMhKZIK1xQInWwC9OmSDJ/StStJe0hDPVLWbB7hVg==' },
    { name: '@deepseek-ai/dsh-fs', version: '0.1.1-rc.2', integrity: 'sha512-8j+6MffvCHATLQrhAVfc9rKyunKu/O7mjjJzmdsUSdID7V4iUYMwqPamhlAyI+tfohZu/vcforKzCRIZGmCYug==' },
    { name: '@deepseek-ai/dsh-fs-local', version: '0.1.1-rc.2', integrity: 'sha512-jvn1MsAMqCmt5SjRNkPjmpc+RIWrZQrBVtf/OpmKr2PaBEGqSbCkPApWDE9iSMhcuQg6k5evScOXwAsduzKOLA==' },
    { name: '@deepseek-ai/dsh-fs-sandbox', version: '0.1.1-rc.2', integrity: 'sha512-PI65uLZ3ARkfVV/PXvACS1HEXggoOaXgYQzXQFdLOfm7AiHOdZWZccUAXBetpZhcNYIOKsVoLnfZkXcHByqecQ==' },
    { name: '@deepseek-ai/dsh-fs-observation-policy', version: '0.1.1-rc.2', integrity: 'sha512-rlq7yu4xavkKK1Oa1/aNCOeUW7t/3OXJJOfOcZXuUgJn5f8G0AbpTDpp2CeuL1cHlKpbunGhEkKQ2N/dv7ZR9w==' },
    { name: '@deepseek-ai/dsh-sandbox', version: '0.1.1-rc.2', integrity: 'sha512-rnO2RqZ+ycpwrXrXlMcrhWAICdui3ZVTjNQ8eZrOPE18hAbX3tw0nLFq26sBjMSnBfDQHNZ4VaFpt0p8qhkPWQ==' },
    { name: '@deepseek-ai/dsh-sandbox-policy', version: '0.1.1-rc.2', integrity: 'sha512-cpoIUxCzpZJDTMXVt9gS+qgWEDAWf6rIe715uY1NF0ROoiEXPlmToLsHLF+4pXTW3wWWzpGVswO0bPYEKrQr3g==' },
    { name: '@deepseek-ai/dsh-user-approval', version: '0.1.1-rc.2', integrity: 'sha512-SdsO4Rs+NeJFoertkVilXBACREOLfkKPJJznYKqDhJxeRo38RJ56dtj0Xd0/6rERmsQiMck4Bwdrzg1ubUqPNA==' },
    { name: '@deepseek-ai/dsh-attachment', version: '0.1.1-rc.2', integrity: 'sha512-rCYAt8QsawP1yfDCU7XxNwYT/XWvyFsxYrkwhLLkdfW83QVD0CQHizSkTQE7RFX74nKUD1z3sTLfnLr7xneArw==' },
    { name: '@deepseek-ai/dsh-system-prompt', version: '0.1.1-rc.2', integrity: 'sha512-on4hjAlYI5uX9q7Sf95YkMMBVe6heywtA/H50ksrIMUub8U2B98hO9iQpHhjwIO1F1vu+5pLcPvRr6yUGGmtXQ==' },
  ]),
  defineCohort('dsh-0.1.2-alpha.2', ['0.1.2-alpha.2'], ['posix', 'windows'], ALPHA2_HOST_PACKAGES),
  defineCohort('dsh-0.1.2-alpha.2-dshmarket-1.39.0', ['0.1.2-alpha.2'], ['posix', 'windows'], ALPHA2_DSHMARKET_139_HOST_PACKAGES),
  defineCohort('dsh-0.1.2-alpha.3', ['0.1.2-alpha.3'], ['posix', 'windows'], ALPHA3_HOST_PACKAGES),
  defineCohort('dsh-0.1.2-rc.1', ['0.1.2-rc.1'], ['posix', 'windows'], RC1_HOST_PACKAGES),
]

/**
 * rc.2 audited package identities (first registry cohort). The audited
 * cohort is an atomic whole-graph contract (CG-DSH-001): any drifted,
 * duplicated, unknown-version, unbound, OR MISSING row fails the whole lock
 * closed (`host_lock_missing`); no capability inherits independence from a
 * partially present graph.
 */
export const EXPECTED_HOST_PACKAGES: PackageRow[] = HOST_COHORTS[0].packages

const packageNames = (...names: string[]): ReadonlySet<string> => new Set(names)

export const BASE_HOST_PACKAGES: ReadonlySet<string> = packageNames(
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-tools',
)

export const GOAL_HOST_PACKAGES: ReadonlySet<string> = packageNames('@deepseek-ai/dsh-goal', '@deepseek-ai/dsh-tool-goal')

export type HostCapabilityId =
  | 'agent_loop'
  | 'terminal_posix'
  | 'terminal_windows'
  | 'dsh_cli'
  | 'plugin_inventory'
  | 'web_control'
  | 'jobs'
  | 'filesystem'

export const HOST_CAPABILITY_PACKAGE_GROUPS: Readonly<Record<HostCapabilityId, ReadonlySet<string>>> = {
  agent_loop: packageNames('@deepseek-ai/dsh-agent-loop'),
  terminal_posix: packageNames(
    '@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-shell', '@deepseek-ai/dsh-subprocess-local',
    '@deepseek-ai/dsh-bash-sandbox', '@deepseek-ai/dsh-shell-env',
  ),
  terminal_windows: packageNames(
    '@deepseek-ai/dsh-tool-pwsh', '@deepseek-ai/dsh-shell', '@deepseek-ai/dsh-subprocess-local',
    '@deepseek-ai/dsh-pwsh-sandbox', '@deepseek-ai/dsh-shell-env',
  ),
  dsh_cli: packageNames('@deepseek-ai/dsh'),
  plugin_inventory: packageNames('@deepseek-ai/dsh-host-plugin-inventory'),
  web_control: packageNames('dshmarket', '@deepseek-ai/dsh-host-webserver', '@deepseek-ai/dsh-web-app'),
  // `dsh-jobs` owns the lifecycle/status contract, `dsh-jobs-local` is the
  // process-local provider behind ctx.jobs, and `dsh-tool-jobs` attaches the
  // controller without which the pinned registry refuses job admission.
  jobs: packageNames('@deepseek-ai/dsh-jobs', '@deepseek-ai/dsh-jobs-local', '@deepseek-ai/dsh-tool-jobs'),
  // `dsh-tool-fs` owns the exact read/write/edit schemas, results, and
  // presentation surface. The rest of this group is the mounted local,
  // observation, sandbox-policy, and approval chain that decides whether a
  // persisted result denotes the same protected filesystem effect.
  filesystem: packageNames(
    '@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-fs', '@deepseek-ai/dsh-fs-local',
    '@deepseek-ai/dsh-fs-sandbox', '@deepseek-ai/dsh-fs-observation-policy',
    '@deepseek-ai/dsh-sandbox', '@deepseek-ai/dsh-sandbox-policy', '@deepseek-ai/dsh-user-approval',
    '@deepseek-ai/dsh-attachment', '@deepseek-ai/dsh-system-prompt',
  ),
}

export interface HostCapabilityEvaluation {
  id: string
  status: HostLockStatus
  digest: string
  requiredPackages: string[]
  missingPackages: string[]
  reasonCode?:
    | 'host_capability_missing'
    | 'host_capability_version_mismatch'
    | 'host_capability_integrity_mismatch'
    | 'host_capability_duplicate_package'
    | 'host_capability_context_missing'
    | 'host_capability_request_unsupported'
}

export interface HostLockEvaluation {
  status: HostLockStatus
  digest: string
  goalAvailable: boolean
  reasonCode?:
    | 'host_lock_missing'
    | 'host_lock_version_mismatch'
    | 'host_lock_integrity_mismatch'
    | 'host_lock_unknown_package'
    | 'host_lock_duplicate_package'
    | 'host_lock_goal_graph_incomplete'
    | 'host_lock_goal_capability_mismatch'
    | 'host_lock_cohort_mixed_graph'
    | 'host_lock_cohort_unbound_identity'
    | 'host_lock_cohort_platform_not_audited'
  packages: PackageRow[]
  capabilities: Record<HostCapabilityId, HostCapabilityEvaluation>
  platform?: HostPlatform
  profileKind?: HostProfileKind
  liveGoalAvailable?: boolean
  /** Readback of the audited cohort the supplied graph was evaluated against. */
  cohortId?: string
  /** Audited cohort rows absent from the supplied graph (diagnostic). */
  missingPackages?: string[]
}

export interface HostLockContext {
  platform?: HostPlatform
  profileKind?: HostProfileKind
  capabilityId?: string
}

export type HostCohortSelectionReason =
  | 'host_cohort_unknown_package'
  | 'host_cohort_version_mismatch'
  | 'host_cohort_integrity_mismatch'
  | 'host_cohort_mixed_graph'
  | 'host_cohort_incomplete_graph'
  | 'host_cohort_unbound_identity'
  | 'host_cohort_platform_not_audited'

export interface HostCohortSelection {
  /**
   * Cohort used for expected-row lookups and digest identity. When the graph
   * does not consistently match one cohort this is the deterministic
   * closest-cohort fallback (most exact row matches, then registry order) and
   * `consistent` is false, so evaluation fails closed downstream.
   */
  cohort: HostCohort
  /**
   * True only when every supplied row exactly matches the selected cohort
   * AND every audited cohort row is present: the audited cohort is an atomic
   * whole-graph contract, so a graph missing audited rows (missing packages)
   * never selects consistently.
   */
  consistent: boolean
  reasonCode?: HostCohortSelectionReason
}

/**
 * Atomically select the audited cohort for one supplied package graph. A
 * graph matches a cohort only when every row carries version and integrity,
 * each exactly equals that cohort's audited row, and the graph covers the
 * complete audited cohort (missing packages fail closed); graphs that mix
 * rows from different cohorts, use versions unknown to the registry, or
 * target a platform the cohort was never audited on never select
 * consistently.
 */
export function selectHostCohort(
  rows: readonly PackageRow[],
  platform?: HostPlatform,
): HostCohortSelection {
  const registryNames = new Set(HOST_COHORTS.flatMap((cohort) => cohort.packages.map((row) => row.name)))
  if (rows.some((row) => !registryNames.has(row.name))) {
    return { cohort: HOST_COHORTS[0], consistent: false, reasonCode: 'host_cohort_unknown_package' }
  }
  if (rows.length === 0) {
    return { cohort: HOST_COHORTS[0], consistent: false, reasonCode: 'host_cohort_unbound_identity' }
  }
  // Per row: the cohorts whose audited row matches this row's version, and
  // among those, the cohorts whose full identity matches exactly.
  const bound = rows.filter((row) => row.version !== undefined && row.integrity !== undefined)
  const unboundCount = rows.length - bound.length
  const versionMatches = bound.map((row) => HOST_COHORTS.filter((cohort) =>
    cohort.packages.some((p) => p.name === row.name && p.version === row.version)))
  const identityMatches = bound.map((row, index) => versionMatches[index].filter((cohort) =>
    cohort.packages.some((p) => p.name === row.name && p.version === row.version && p.integrity === row.integrity)))
  const consistentCohort = HOST_COHORTS.find((cohort) => identityMatches.every((matches) => matches.includes(cohort)))
  if (consistentCohort !== undefined && unboundCount === 0) {
    if (platform && !consistentCohort.auditedPlatforms.includes(platform)) {
      // The exact graph was audited, but never on this platform; integrity
      // must not be inferred across platforms.
      return { cohort: consistentCohort, consistent: false, reasonCode: 'host_cohort_platform_not_audited' }
    }
    const suppliedCounts = new Map<string, number>()
    for (const row of rows) suppliedCounts.set(row.name, (suppliedCounts.get(row.name) ?? 0) + 1)
    const complete = consistentCohort.packages.every((row) => (suppliedCounts.get(row.name) ?? 0) === 1)
      && rows.length === consistentCohort.packages.length
    if (!complete) {
      // CG-DSH-001: the audited cohort is one indivisible whole-graph
      // contract — a graph missing audited rows (or carrying duplicates)
      // never selects consistently and fails closed downstream.
      return { cohort: consistentCohort, consistent: false, reasonCode: 'host_cohort_incomplete_graph' }
    }
    return { cohort: consistentCohort, consistent: true }
  }
  // Mixture signal first: when the rows that do exactly match some cohort
  // are not all covered by one cohort, the graph mixes cohorts even if
  // unrelated drifted rows are present.
  const matchingIndices = identityMatches.flatMap((matches, index) => matches.length > 0 ? [index] : [])
  const mixtureCovered = HOST_COHORTS.filter((cohort) => matchingIndices.every((index) => identityMatches[index].includes(cohort)))
  let reasonCode: HostCohortSelectionReason
  if (matchingIndices.length > 0 && mixtureCovered.length === 0) {
    reasonCode = 'host_cohort_mixed_graph'
  } else if (bound.length > 0 && versionMatches.some((matches) => matches.length === 0)) {
    // At least one row's version (or name) is audited in no cohort.
    reasonCode = 'host_cohort_version_mismatch'
  } else if (bound.length > 0 && identityMatches.some((matches) => matches.length === 0)) {
    // Every version is audited somewhere, but at least one integrity never
    // matches the cohort that carries that version.
    reasonCode = 'host_cohort_integrity_mismatch'
  } else {
    reasonCode = 'host_cohort_unbound_identity'
  }
  // Deterministic closest-cohort fallback for expected-row lookups and
  // digest diagnostics: most exact identity matches, then registry order.
  const fallback = [...HOST_COHORTS].sort((a, b) => {
    const scoreOf = (cohort: HostCohort) => identityMatches.filter((matches) => matches.includes(cohort)).length
    return scoreOf(b) - scoreOf(a) || HOST_COHORTS.indexOf(a) - HOST_COHORTS.indexOf(b)
  })[0]
  return { cohort: fallback, consistent: false, reasonCode }
}

function stableRows(rows: readonly PackageRow[]): PackageRow[] {
  return [...rows].map((row) => ({ ...row })).sort((a, b) =>
    a.name.localeCompare(b.name)
      || (a.version ?? '').localeCompare(b.version ?? '')
      || (a.integrity ?? '').localeCompare(b.integrity ?? ''))
}

function statusForPackages(
  id: string,
  rows: readonly PackageRow[],
  requiredNames: ReadonlySet<string>,
  cohort: HostCohort,
): HostCapabilityEvaluation {
  const requiredPackages = [...requiredNames].sort()
  const relevant = rows.filter((row) => requiredNames.has(row.name))
  const counts = new Map<string, number>()
  for (const row of relevant) counts.set(row.name, (counts.get(row.name) ?? 0) + 1)
  const missingPackages = requiredPackages.filter((name) => !counts.has(name))
  const digest = safeHostLockDigest(relevant, { capabilityId: id }, cohort)
  if ([...counts.values()].some((count) => count > 1)) {
    return { id, status: 'unavailable', digest, requiredPackages, missingPackages, reasonCode: 'host_capability_duplicate_package' }
  }
  if (missingPackages.length > 0) {
    return { id, status: 'unavailable', digest, requiredPackages, missingPackages, reasonCode: 'host_capability_missing' }
  }
  const expected = new Map(cohort.packages.map((row) => [row.name, row]))
  for (const row of relevant) {
    const pinned = expected.get(row.name)!
    if (!row.version || !row.integrity) {
      return { id, status: 'unavailable', digest, requiredPackages, missingPackages, reasonCode: 'host_capability_missing' }
    }
    if (row.version !== pinned.version) {
      return { id, status: 'unsupported', digest, requiredPackages, missingPackages, reasonCode: 'host_capability_version_mismatch' }
    }
    if (row.integrity !== pinned.integrity) {
      return { id, status: 'unsupported', digest, requiredPackages, missingPackages, reasonCode: 'host_capability_integrity_mismatch' }
    }
  }
  return { id, status: 'supported', digest, requiredPackages, missingPackages }
}

function capabilityEvaluations(rows: readonly PackageRow[], cohort: HostCohort): Record<HostCapabilityId, HostCapabilityEvaluation> {
  return Object.fromEntries(Object.entries(HOST_CAPABILITY_PACKAGE_GROUPS).map(([id, packages]) => (
    [id, statusForPackages(id, rows, packages, cohort)]
  ))) as Record<HostCapabilityId, HostCapabilityEvaluation>
}

function cohortForEvaluation(evaluation: Pick<HostLockEvaluation, 'cohortId'>): HostCohort {
  return HOST_COHORTS.find((cohort) => cohort.id === evaluation.cohortId) ?? HOST_COHORTS[0]
}

export function evaluateHostLock(rows: readonly PackageRow[], context: HostLockContext = {}): HostLockEvaluation {
  const supplied = stableRows(rows)
  const selection = selectHostCohort(supplied, context.platform)
  const cohort = selection.cohort
  const capabilities = capabilityEvaluations(supplied, cohort)
  const counts = new Map<string, number>()
  for (const row of supplied) counts.set(row.name, (counts.get(row.name) ?? 0) + 1)
  const goalRows = [...GOAL_HOST_PACKAGES].filter((name) => counts.has(name))
  const goalAvailable = goalRows.length === GOAL_HOST_PACKAGES.size
  const digest = safeHostLockDigest(supplied, context, cohort)
  const base = statusForPackages('base', supplied, BASE_HOST_PACKAGES, cohort)
  const missingPackages = cohort.packages
    .map((row) => row.name)
    .filter((name) => (counts.get(name) ?? 0) === 0)
    .sort((a, b) => a.localeCompare(b))
  const registryNames = new Set(HOST_COHORTS.flatMap((entry) => entry.packages.map((row) => row.name)))
  const unknown = supplied.find((row) => !registryNames.has(row.name))
  const baseResult = {
    digest,
    goalAvailable,
    packages: supplied,
    capabilities,
    cohortId: cohort.id,
    missingPackages,
    ...(context.platform ? { platform: context.platform } : {}),
    ...(context.profileKind ? { profileKind: context.profileKind } : {}),
  }
  if (unknown) return { ...baseResult, status: 'unsupported', reasonCode: 'host_lock_unknown_package' }
  // CG-DSH-001: duplicates are a whole-graph failure, not a critical-row-only
  // one — a duplicated optional row is equally uncertifiable.
  if (supplied.some((row) => (counts.get(row.name) ?? 0) > 1)) {
    return { ...baseResult, status: 'unavailable', goalAvailable: false, reasonCode: 'host_lock_duplicate_package' }
  }
  if (goalRows.length > 0 && !goalAvailable) {
    return { ...baseResult, status: 'unavailable', goalAvailable: false, reasonCode: 'host_lock_goal_graph_incomplete' }
  }
  if (base.status !== 'supported') {
    const reasonCode = base.reasonCode === 'host_capability_version_mismatch'
      ? 'host_lock_version_mismatch'
      : base.reasonCode === 'host_capability_integrity_mismatch'
        ? 'host_lock_integrity_mismatch'
        : base.reasonCode === 'host_capability_duplicate_package'
          ? 'host_lock_duplicate_package'
          : 'host_lock_missing'
    return { ...baseResult, status: base.status, reasonCode }
  }
  if (goalAvailable) {
    const goal = statusForPackages('goal', supplied, GOAL_HOST_PACKAGES, cohort)
    if (goal.status !== 'supported') {
      return {
        ...baseResult,
        status: goal.status,
        goalAvailable: false,
        reasonCode: goal.reasonCode === 'host_capability_version_mismatch'
          ? 'host_lock_version_mismatch'
          : goal.reasonCode === 'host_capability_integrity_mismatch'
            ? 'host_lock_integrity_mismatch'
            : 'host_lock_missing',
      }
    }
  }
  // CG-DSH-001: cohort selection is atomic over the whole audited graph.
  // Every inconsistency — cross-cohort mixtures, never-audited platforms,
  // unknown versions, drifted integrity, unbound identities, or missing
  // audited rows, in required or optional packages — fails the whole lock
  // closed; a drifted or missing optional row can never leave the lock
  // `supported`.
  if (!selection.consistent) {
    // Identity mismatches with the audited cohort are `unsupported`; graphs
    // that cannot certify the host at all (missing rows) are `unavailable`.
    const reasonBySelection: Record<HostCohortSelectionReason, { status: HostLockStatus; reasonCode: NonNullable<HostLockEvaluation['reasonCode']> }> = {
      host_cohort_unknown_package: { status: 'unsupported', reasonCode: 'host_lock_unknown_package' },
      host_cohort_version_mismatch: { status: 'unsupported', reasonCode: 'host_lock_version_mismatch' },
      host_cohort_integrity_mismatch: { status: 'unsupported', reasonCode: 'host_lock_integrity_mismatch' },
      host_cohort_mixed_graph: { status: 'unsupported', reasonCode: 'host_lock_cohort_mixed_graph' },
      host_cohort_incomplete_graph: { status: 'unavailable', reasonCode: 'host_lock_missing' },
      host_cohort_unbound_identity: { status: 'unsupported', reasonCode: 'host_lock_cohort_unbound_identity' },
      host_cohort_platform_not_audited: { status: 'unsupported', reasonCode: 'host_lock_cohort_platform_not_audited' },
    }
    const failure = reasonBySelection[selection.reasonCode ?? 'host_cohort_unbound_identity']
    return {
      ...baseResult,
      status: failure.status,
      goalAvailable: false,
      reasonCode: failure.reasonCode,
    }
  }
  return { ...baseResult, status: 'supported' }
}

const TERMINAL_ACTIONS: ReadonlySet<SemanticAction> = new Set([
  'inspect_remote_updates', 'install', 'apply', 'test', 'verify', 'pull', 'fetch',
  'commit', 'push', 'publish', 'generic_run',
])

export interface HostCapabilityRequest {
  action: SemanticAction
  platform?: HostPlatform
  profileKind?: HostProfileKind
}

/** Evaluate only the packages needed for one effect/readback capability. */
export function evaluateHostCapability(
  evaluation: HostLockEvaluation,
  request: HostCapabilityRequest,
): HostCapabilityEvaluation {
  const platform = request.platform ?? evaluation.platform
  const profileKind = request.profileKind ?? evaluation.profileKind
  const groups: HostCapabilityId[] = ['agent_loop']
  if (TERMINAL_ACTIONS.has(request.action)) {
    if (!platform) {
      return {
        id: `action.${request.action}`,
        status: 'unavailable',
        digest: evaluation.digest,
        requiredPackages: [],
        missingPackages: [],
        reasonCode: 'host_capability_context_missing',
      }
    }
    groups.push(platform === 'windows' ? 'terminal_windows' : 'terminal_posix')
  }
  if (request.action === 'create' || request.action === 'modify') groups.push('filesystem')
  if (request.action === 'install' || request.action === 'apply') groups.push('dsh_cli')
  if (request.action === 'apply') groups.push('plugin_inventory')
  if ((request.action === 'apply' || request.action === 'restart') && profileKind === 'web') groups.push('web_control')
  if (request.action === 'restart' && profileKind !== 'web') {
    return {
      id: 'action.restart',
      status: 'unavailable',
      digest: evaluation.digest,
      requiredPackages: [],
      missingPackages: [],
      reasonCode: profileKind ? 'host_capability_request_unsupported' : 'host_capability_context_missing',
    }
  }
  const required = new Set<string>(BASE_HOST_PACKAGES)
  for (const group of groups) for (const name of HOST_CAPABILITY_PACKAGE_GROUPS[group]) required.add(name)
  const result = statusForPackages(`action.${request.action}.${platform ?? 'native'}.${profileKind ?? 'unknown'}`, evaluation.packages, required, cohortForEvaluation(evaluation))
  if (evaluation.status !== 'supported') {
    return { ...result, status: evaluation.status, digest: evaluation.digest }
  }
  return result
}

/**
 * Bind external_wait qualification and pre-effect requalification to the
 * exact jobs service definition, local provider, and live controller graph.
 * This is deliberately independent of the global/base lock so profiles that
 * do not support background jobs can still use unrelated Guard actions.
 */
export function evaluateExternalWaitCapability(
  evaluation: HostLockEvaluation,
): HostCapabilityEvaluation {
  const required = new Set<string>(BASE_HOST_PACKAGES)
  for (const name of HOST_CAPABILITY_PACKAGE_GROUPS.jobs) required.add(name)
  const result = statusForPackages('boundary.external_wait.jobs', evaluation.packages, required, cohortForEvaluation(evaluation))
  if (evaluation.status !== 'supported') {
    return { ...result, status: evaluation.status, digest: evaluation.digest }
  }
  return result
}

export type HostToolSurface = 'bash' | 'pwsh' | 'filesystem'

/**
 * Gate automatically replayed ordinary tool results by the exact host
 * capability that owns their registration and outcome surface. Tool names are
 * intentionally separate from semantic actions: a `bash` result on Windows,
 * or a `pwsh` result on POSIX, is not evidence from the active host stack.
 */
export function evaluateToolSurfaceCapability(
  evaluation: HostLockEvaluation,
  surface: HostToolSurface,
): HostCapabilityEvaluation {
  const platform = evaluation.platform
  if (surface !== 'filesystem' && !platform) {
    return {
      id: `tool.${surface}.unknown`, status: 'unavailable', digest: evaluation.digest,
      requiredPackages: [], missingPackages: [], reasonCode: 'host_capability_context_missing',
    }
  }
  if ((surface === 'bash' && platform !== 'posix') || (surface === 'pwsh' && platform !== 'windows')) {
    return {
      id: `tool.${surface}.${platform}`, status: 'unsupported', digest: evaluation.digest,
      requiredPackages: [], missingPackages: [], reasonCode: 'host_capability_request_unsupported',
    }
  }
  const groups: HostCapabilityId[] = ['agent_loop']
  if (surface === 'filesystem') groups.push('filesystem')
  if (surface === 'bash') groups.push('terminal_posix')
  if (surface === 'pwsh') groups.push('terminal_windows')
  const required = new Set<string>(BASE_HOST_PACKAGES)
  for (const group of groups) for (const name of HOST_CAPABILITY_PACKAGE_GROUPS[group]) required.add(name)
  const result = statusForPackages(`tool.${surface}.${platform ?? 'native'}`, evaluation.packages, required, cohortForEvaluation(evaluation))
  if (evaluation.status !== 'supported') {
    return { ...result, status: evaluation.status, digest: evaluation.digest }
  }
  return result
}

function safeHostLockDigest(packages: readonly PackageRow[], context: HostLockContext = {}, cohort: HostCohort): string {
  try {
    // The cohort manifest (including its `host_cohort` identity row and its
    // own supportedGoalVersions) is the digest root, so certificates are
    // bound to the audited cohort and a cohort switch invalidates them.
    const capabilities = [
      ...cohort.capabilities,
      ...(context.platform ? [{ name: 'active_platform', value: { k: 's' as const, v: context.platform } }] : []),
      ...(context.profileKind ? [{ name: 'active_profile', value: { k: 's' as const, v: context.profileKind } }] : []),
      ...(context.capabilityId ? [{ name: 'active_capability', value: { k: 's' as const, v: context.capabilityId } }] : []),
    ]
    return hostLockDigest({
      manifestVersion: cohort.manifestVersion,
      supportedGoalVersions: [...cohort.supportedGoalVersions],
      capabilities,
      packages: [...packages],
    })
  } catch {
    const bounded = {
      packages: packages.map((row) => [String(row.name), row.version ?? null, row.integrity ?? null]),
      platform: context.platform ?? null,
      profileKind: context.profileKind ?? null,
      capabilityId: context.capabilityId ?? null,
    }
    return createHash('sha256')
      .update('ccg.invalidHostLockDigest.v1\n', 'utf8')
      .update(JSON.stringify(bounded), 'utf8')
      .digest('hex')
  }
}

/** Bind the injected Goal graph to the live Goal service for this agent. */
export function bindLiveGoalCapability(
  evaluation: HostLockEvaluation,
  liveGoalAvailable: boolean,
): HostLockEvaluation {
  if (evaluation.status !== 'supported') return { ...evaluation, liveGoalAvailable }
  if (evaluation.goalAvailable !== liveGoalAvailable) {
    return {
      ...evaluation,
      status: 'unavailable',
      reasonCode: 'host_lock_goal_capability_mismatch',
      liveGoalAvailable,
    }
  }
  return { ...evaluation, liveGoalAvailable }
}

export type AuditedExecutable = 'git' | 'npm' | 'pnpm' | 'dsh'

export interface ExecutableIdentity {
  executable: AuditedExecutable
  realpath: string
  version: string
  interpreterRealpath?: string
  interpreterVersion?: string
}

export interface ExecutableIdentityBinding {
  status: HostLockStatus
  digest: string
  identity?: ExecutableIdentity
  reasonCode?: 'executable_identity_missing' | 'executable_realpath_invalid' | 'executable_identity_drift'
}

function executableDigest(identity: ExecutableIdentity | undefined): string {
  return createHash('sha256')
    .update('ccg.executableIdentity.v1\n', 'utf8')
    .update(JSON.stringify(identity ?? null), 'utf8')
    .digest('hex')
}

function validExecutableIdentity(identity: ExecutableIdentity | undefined): identity is ExecutableIdentity {
  if (!identity || !['git', 'npm', 'pnpm', 'dsh'].includes(identity.executable)) return false
  if (!identity.version || /[\r\n\0]/.test(identity.version)) return false
  if (!(identity.realpath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(identity.realpath))
    || /[\r\n\0]/.test(identity.realpath)) return false
  const interpreterFields = [identity.interpreterRealpath, identity.interpreterVersion]
  if (interpreterFields.every((value) => value === undefined)) return true
  return typeof identity.interpreterRealpath === 'string'
    && /^[A-Za-z]:[\\/]/.test(identity.interpreterRealpath)
    && !/[\r\n\0]/.test(identity.interpreterRealpath)
    && typeof identity.interpreterVersion === 'string'
    && identity.interpreterVersion.length > 0
    && !/[\r\n\0]/.test(identity.interpreterVersion)
}

/** Bind resolution and effect to the exact same canonical executable tuple. */
export function bindExecutableIdentity(
  resolution: ExecutableIdentity | undefined,
  effect: ExecutableIdentity | undefined,
): ExecutableIdentityBinding {
  if (!resolution || !effect) {
    return { status: 'unavailable', digest: executableDigest(resolution), reasonCode: 'executable_identity_missing' }
  }
  if (!validExecutableIdentity(resolution) || !validExecutableIdentity(effect)) {
    return { status: 'unavailable', digest: executableDigest(resolution), reasonCode: 'executable_realpath_invalid' }
  }
  if (resolution.executable !== effect.executable
    || resolution.realpath !== effect.realpath
    || resolution.version !== effect.version
    || resolution.interpreterRealpath !== effect.interpreterRealpath
    || resolution.interpreterVersion !== effect.interpreterVersion) {
    return { status: 'unsupported', digest: executableDigest(resolution), reasonCode: 'executable_identity_drift' }
  }
  return { status: 'supported', digest: executableDigest(resolution), identity: { ...resolution } }
}

// CG-DSH-001: the default host identity is the complete audited cohort graph
// (fail-closed would make every derivation without an explicit host readback
// unusable); callers that evaluate a real host always pass an explicit lock.
export const DEFAULT_HOST_LOCK: HostLockEvaluation = evaluateHostLock(EXPECTED_HOST_PACKAGES)
