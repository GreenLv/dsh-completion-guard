import z from '@deepseek-ai/schemastery'

export const Config: z<{ activation: string }> = z.object({
  activation: z.string().default('opt-in'),
})

export interface ResolvedConfig {
  activation: 'opt-in' | 'always'
}

export function resolveConfig(config: { activation?: unknown }): ResolvedConfig {
  const activation = config.activation ?? 'opt-in'
  if (activation !== 'opt-in' && activation !== 'always') {
    throw new TypeError(`activation must be "opt-in" or "always", received ${JSON.stringify(activation)}`)
  }
  return { activation }
}
