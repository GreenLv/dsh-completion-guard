/** rc.2 producers own their source kind. Historical plugin notices remain read-only input. */
import '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'context-guard': {
      readonly kind: 'context-guard'
      readonly plugin: 'context-guard'
      readonly form: 'notice'
      readonly summary: string
    }
  }
}
