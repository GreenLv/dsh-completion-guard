/** The Session observation watermark advances when a read-only Guard tool
 * records its own result. It is not a change to the current business state.
 * Keep every other core field in cursor identity so changed predicates,
 * actions, coverage, and release state still invalidate a page. */
export function semanticCoreCursorState(core: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!core) return null
  const { as_of: _observationWatermark, ...semantic } = core
  return semantic
}
