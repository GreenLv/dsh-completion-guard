import type { PackageRow } from './digest.js'

/**
 * Exact 33-row DSH 0.1.5-rc.1 core graph.
 *
 * Provenance: every row is the npm registry `dist.integrity` of the exact
 * published tarball for the named version, read from
 * `https://registry.npmjs.org/<name>/0.1.5-rc.1` (and `4.0.2` for
 * `@deepseek-ai/cordis`, which is versioned independently of DSH). The single
 * resolver for this graph is an isolated DSH installation plus the repository
 * worktree lockfile, both installed from the public registry.
 *
 * This is a REGISTRY-DERIVED graph, not a natively audited one: the cohort
 * carries `auditedPlatforms: []` until a native macOS/Windows host audit runs,
 * and `auditProvenance: 'registry-derived-pending-native-audit'` is bound into
 * the host-lock digest so a certificate can never claim a native pass this round
 * did not produce. (`acceptedPlatforms` is the separate, wider gate: this cohort
 * accepts evaluation on both platforms while claiming an audit on neither.)
 * `dshmarket` is deliberately absent: market identity is verified independently
 * by the action adapter and never participates in the core lock.
 *
 * The row-name set is unchanged from the historical 0.1.2-rc.1 cohort's 33
 * core rows: no package entered or left the audited core graph, so a future
 * reader must not infer a graph change from the version bump alone. The count
 * is asserted from this list, never assumed.
 */
export const RC015_HOST_PACKAGES: PackageRow[] = [
  ['@deepseek-ai/cordis', '4.0.2', 'sha512-asOnXP1TzFSFQlHb1iegDZp0z/8WD1c7YNrwJR/Tx2bzNuMXfcekE/I67Iv6SQXeLB4csxqCngzQKANP7gdw0g=='],
  ['@deepseek-ai/dsh', '0.1.5-rc.1', 'sha512-rmNmzQCg3oIc1z8xH7izRSOuy1TNzq+/NILyfM+7e8DKOyV+yBtg47WEsqR2SiIe1ATec3L/rUa1YhIcfQ2XEg=='],
  ['@deepseek-ai/dsh-agent', '0.1.5-rc.1', 'sha512-obIPyTSjq1y0Yhasm3mLhK5BW6Ge0VQoRT8FBt0ooLsct2+pFAjgyd7GP3KzFaz7zaEhQJ/NNEmCaU0KOsYutg=='],
  ['@deepseek-ai/dsh-agent-loop', '0.1.5-rc.1', 'sha512-FcpsiXMHR7M3UwZtC6CYzhmU9xhvbFuuEQisfUqW7c+G6oVhrX9kg8ytI50jXZempcdmVHZLyNeUcuDmgGtx7Q=='],
  ['@deepseek-ai/dsh-attachment', '0.1.5-rc.1', 'sha512-uTBtB/LDlYgPI6i9Ac9jaK/bV1wN8cDTZBUkec80Yg3qMzW6K74wvBv5lPmoiXQgp4q3eOmDNEmodSS2ZxxVdg=='],
  ['@deepseek-ai/dsh-bash-sandbox', '0.1.5-rc.1', 'sha512-mQ+/0Fo3LTIX+4k3m+P4y9e9IA6/BeNHrWW19U+Un4hBo5JtTwWhAaJN1nCdV6mG5tveXbIe2tpiv65GJdvt8w=='],
  ['@deepseek-ai/dsh-commands', '0.1.5-rc.1', 'sha512-OMk0uVNbr2RdsItcIigp/2boGulqjei1uoQH3/DZYHB+aWWRXEYa6rk6vW3t82lnkd/6nvyQFV8eccQWZ2PQXQ=='],
  ['@deepseek-ai/dsh-fs', '0.1.5-rc.1', 'sha512-F+loGiwsT09YpRONuFv0+bevEdfmbKBFjxxM8JkDOXpgwk1JXdGNSy7Kp4vXXVh3GcmYkd8VA7iB7NuVp51ytQ=='],
  ['@deepseek-ai/dsh-fs-local', '0.1.5-rc.1', 'sha512-Qyqs9l+ZENq4PL7EwBpisvXcqJvCxGTrD/zH0Zj+S0eZee1kXrQjkY0gjW6dxAosGlLL7hZu0kdaD7TPxtKVcA=='],
  ['@deepseek-ai/dsh-fs-observation-policy', '0.1.5-rc.1', 'sha512-TGu/2UrZS8KWr6x3sKLce7u0KoGrq5l+RK7ITd79n2WNzSCcAdzN5tsxUEo8JgfHij5S0QRgID0Q8DOx/6iQew=='],
  ['@deepseek-ai/dsh-fs-sandbox', '0.1.5-rc.1', 'sha512-np+3EdQ86w609DwyaEUFGEHjSQ5i2NFypQxcM9sB+zX6DVSUR9sA2W/fmnStFJdsSzvgXYTCnJiBhlKnAXPf0g=='],
  ['@deepseek-ai/dsh-goal', '0.1.5-rc.1', 'sha512-RF+cHqV0O7xkoqkhIst6NhMAwqXXAjTf7Z+H7FLHtZBvFAawU8zC7n7/tmS4P7rZYV+XYFYCDdNoI0GwPReCYA=='],
  ['@deepseek-ai/dsh-host-plugin-inventory', '0.1.5-rc.1', 'sha512-xCOJ1nTW2s5etl18QhBBGpcOxiDfGxofe+4pd90/ZX+vW1vAhaHqyTYSRucOQVGyJb9zvdWCg7R3GcBYn6pUrQ=='],
  ['@deepseek-ai/dsh-host-webserver', '0.1.5-rc.1', 'sha512-5kOu9kb0AuRN60/zwPTRcki801ozgnWAFwS1QtQ4ZNgCYIbAiU8gwJHY1//qEpUOuHS+26k+Tqq5/WCJmLGE6Q=='],
  ['@deepseek-ai/dsh-jobs', '0.1.5-rc.1', 'sha512-0AWlZLcIpwdtV9A9fVeJ7b9jpXX0494fPL594gE/Kp1q9jHYyerIulrMHZa17kpu9W59cb1AJNPQy2xN6VDX7g=='],
  ['@deepseek-ai/dsh-jobs-local', '0.1.5-rc.1', 'sha512-19sCxqUKduNO8E3YICSzOfajpBLPXbK/3p40GlxR6bGcOhxqhyH3TPdQS6UQjwNa5bUXHiW9GyB1xUWUUFGAJA=='],
  ['@deepseek-ai/dsh-llm', '0.1.5-rc.1', 'sha512-KPKJFTNLjURphuF4NlS8DRK94CUYL/dKB8Hzg/22jtxAFO2paX3ifL0vhdPq9xPbcyplaF7LYlf0+3+pXFTnTg=='],
  ['@deepseek-ai/dsh-pwsh-sandbox', '0.1.5-rc.1', 'sha512-QRD6PfcQuaRwUTn9EMIx15l1erRqk0erUamcAB3sxPyZOMWIFP7w2cp44Va8RGGDEUb9ZB1vRUH6cF4FAKSZRw=='],
  ['@deepseek-ai/dsh-sandbox', '0.1.5-rc.1', 'sha512-xT+oTsSE7tRZVqqcj2qDZJARoK6A+Dmhf3CWPqlaFG/83Zh41kwcW2YWE4sA+vCt2pI2iqLYRw1SftSGawOtVQ=='],
  ['@deepseek-ai/dsh-sandbox-policy', '0.1.5-rc.1', 'sha512-jLeny81NVsAiEWW8+MqmtkXJfu8CSFDPiuR8W4I/bZ7TNHrPTN7jPuk1/JlphkU4bq1N1a3iLvsDyHK+56ZLVA=='],
  ['@deepseek-ai/dsh-session', '0.1.5-rc.1', 'sha512-0YBBrzkCbVEJolS/OpD0DZMSozmYxUTZopiG76MXInjOFBW9J4ca1a8WUjJjqelP1nJTmWGKXp92HcvNEny0Dg=='],
  ['@deepseek-ai/dsh-shell', '0.1.5-rc.1', 'sha512-8V7iGmfsXDFMyftwQXemh1QLqcUysvy+bYWXr620/1B/sMn3oU8dhXvT8i4uD6VkMy2rds3XScUQ3XBl7ByMLA=='],
  ['@deepseek-ai/dsh-shell-env', '0.1.5-rc.1', 'sha512-OO4AmGqqHUWRPK1PSroO/TJG3rNwoAgIMx56S3aiM7v4cUtNmUtMQ71lv9kOezcW+2VlHxfup5jhzpYIQAIiSw=='],
  ['@deepseek-ai/dsh-subprocess-local', '0.1.5-rc.1', 'sha512-TKcqaIf1fJzjraXhwmSAQAqkPMvIjS0Y7b9fC4n7+G8eQpb3gaF/eJXn6Tx4OgFSDV5R/NLUqHaU/ogxTjdWhQ=='],
  ['@deepseek-ai/dsh-system-prompt', '0.1.5-rc.1', 'sha512-RAdO9biQoga1vAVTQY9J7THexiOE1FOd1Nli021MQt+Zf73c83BSd2DwXb0WDilLaMeSxZPaIRRqoXpJlpmLIA=='],
  ['@deepseek-ai/dsh-tool-bash', '0.1.5-rc.1', 'sha512-BfZ4R40I7AJFcjHgMkzh3unrp5S7mZT+szUUz4tkbMrAkgHfOdkIHhQ/BTgxWBuFzD18OfAMJ/RnegrBCFVKWw=='],
  ['@deepseek-ai/dsh-tool-fs', '0.1.5-rc.1', 'sha512-BWLWJCJxCECFHmS8gHbnyNJlSTG+KVbVMz73Qduoo+ABeDvWj6cFVXTewAUA9jFEIS3xzJcNilsV1g5DGaEnPw=='],
  ['@deepseek-ai/dsh-tool-goal', '0.1.5-rc.1', 'sha512-5NCniCOoCeXYXMZNPCmGlrOYIGjnGddTJVOCXNqqAcwxtOxHAoEHTtphaohIa/4Vy7mmRIHgO1KUii443ky1Bw=='],
  ['@deepseek-ai/dsh-tool-jobs', '0.1.5-rc.1', 'sha512-SIgxnjQHl6KE+kpt7VjYCI3aw5DCeztCKGxuJzpLdqJkSoVtewp1Ofz0/Pg1R4DIIaGR8unRyqpZH8qf8uIpzA=='],
  ['@deepseek-ai/dsh-tool-pwsh', '0.1.5-rc.1', 'sha512-UmWePfsJIUfFVj2UFyh8wacqxSXYrABGoBHXWjYFlfqpXt7rfJL31rOl8N1+uYypAVCxe4O2IquuJxfYAVhBLA=='],
  ['@deepseek-ai/dsh-tools', '0.1.5-rc.1', 'sha512-I5AUxKTqUrC0nvRO4UcpU+f65P+nKs5BUrS2nqZehhFZ2rVxhUAJ7YdORcY6pVkBTB15nPr5gK0WPgwyfS217w=='],
  ['@deepseek-ai/dsh-user-approval', '0.1.5-rc.1', 'sha512-fSxEBvHQnozIh5HV31t2BNodYzyv7iE2srna7p5k0Y/3R9c6DdoZyQZ9momcN9gloraq8HK5+cvrYHzgc4LYPQ=='],
  ['@deepseek-ai/dsh-web-app', '0.1.5-rc.1', 'sha512-9V2GPqEs0A+LFJVVPt7FQK//U8oM9S0TDhl6MqO7zQftimfnH8ruQZkEZXg9zXXEWULCW0vY1DtsPjvMepA8Mw=='],
].map(([name, version, integrity]) => ({ name, version, integrity } as PackageRow))
