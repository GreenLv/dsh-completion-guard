/** Pure parser storage only. Never store projections, evidence or authority. */
export class ParseCache<T> {
  private readonly entries = new Map<string, { value: T; bytes: number }>()
  private bytes = 0
  constructor(private readonly byteBudget: number, private readonly entryBudget = 32768) {}

  get(key: string): T | undefined { return this.entries.get(key)?.value }

  set(key: string, value: T, valueBytes: number): void {
    // Account retained UTF-16 text plus a conservative entry overhead. This is
    // a storage budget, not a measurement of engine object overhead or RSS.
    const bytes = key.length * 2 + valueBytes + 128
    if (bytes > this.byteBudget) return
    const prior = this.entries.get(key)
    if (prior) { this.bytes -= prior.bytes; this.entries.delete(key) }
    while (this.bytes + bytes > this.byteBudget || this.entries.size >= this.entryBudget) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.bytes -= this.entries.get(oldest)!.bytes
      this.entries.delete(oldest)
    }
    this.entries.set(key, { value, bytes })
    this.bytes += bytes
  }

  /** Deterministic storage diagnostics, without exposing keys or parsed text. */
  storage(): { entries: number; bytes: number } { return { entries: this.entries.size, bytes: this.bytes } }
}
