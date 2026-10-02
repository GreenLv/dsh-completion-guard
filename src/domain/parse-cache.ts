/** Pure parser storage only. Never store projections, evidence or authority. */
export class ParseCache<T> {
  private readonly probation = new Map<string, { value: T; bytes: number }>()
  private readonly protected = new Map<string, { value: T; bytes: number }>()
  private bytes = 0
  private protectedBytes = 0
  constructor(private readonly byteBudget: number, private readonly entryBudget = 32768) {}

  get(key: string): T | undefined {
    const hot = this.protected.get(key)
    if (hot) {
      this.protected.delete(key); this.protected.set(key, hot)
      return hot.value
    }
    const entry = this.probation.get(key)
    if (!entry) return undefined
    this.probation.delete(key)
    this.protected.set(key, entry)
    this.protectedBytes += entry.bytes
    // Reused parses survive a scan of one-use fragments. Bound the protected
    // segment too: its oldest row returns to probation, not unbounded storage.
    while (this.protectedBytes > this.byteBudget * 0.75) {
      const oldest = this.protected.keys().next().value!
      const row = this.protected.get(oldest)!
      this.protected.delete(oldest); this.protectedBytes -= row.bytes
      this.probation.set(oldest, row)
    }
    return entry.value
  }

  set(key: string, value: T, valueBytes: number): void {
    // Account retained UTF-16 text plus a conservative entry overhead. This is
    // a storage budget, not a measurement of engine object overhead or RSS.
    const bytes = key.length * 2 + valueBytes + 128
    if (bytes > this.byteBudget) return
    const cold = this.probation.get(key), hot = this.protected.get(key)
    if (cold) { this.bytes -= cold.bytes; this.probation.delete(key) }
    if (hot) {
      this.bytes -= hot.bytes; this.protectedBytes -= hot.bytes
      this.protected.delete(key)
    }
    while (this.bytes + bytes > this.byteBudget || this.probation.size + this.protected.size >= this.entryBudget) {
      const segment = this.probation.size ? this.probation : this.protected
      const oldest = segment.keys().next().value
      if (oldest === undefined) break
      const row = segment.get(oldest)!
      this.bytes -= row.bytes
      if (segment === this.protected) this.protectedBytes -= row.bytes
      segment.delete(oldest)
    }
    this.probation.set(key, { value, bytes })
    this.bytes += bytes
  }

  /** Deterministic storage diagnostics, without exposing keys or parsed text. */
  storage(): { entries: number; bytes: number } {
    return { entries: this.probation.size + this.protected.size, bytes: this.bytes }
  }
}
