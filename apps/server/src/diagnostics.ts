import { createHash } from 'node:crypto'

type DiagnosticValue = boolean | null | number | string | readonly string[]

type DiagnosticFields = Readonly<Record<string, DiagnosticValue>>

const serviceName = 'cqai-account-service'

/**
 * Write a structured diagnostic event when temporary debug logging is enabled.
 *
 * @param enabled Whether the event should be written.
 * @param event The stable event name.
 * @param fields Secret-free event fields.
 * @returns Nothing.
 */
export function debugLog(enabled: boolean, event: string, fields: DiagnosticFields = {}): void {
  if (!enabled) return
  console.log(JSON.stringify({ service: serviceName, event, ...fields }))
}

/**
 * Write a structured error event using only fixed, secret-free fields.
 *
 * @param event The stable event name.
 * @param fields Secret-free event fields.
 * @returns Nothing.
 */
export function errorLog(event: string, fields: DiagnosticFields = {}): void {
  console.error(JSON.stringify({ service: serviceName, event, ...fields }))
}

/**
 * Create a short correlation value for an opaque identity claim.
 *
 * @param value The identity value to correlate without printing directly.
 * @returns A truncated SHA-256 fingerprint.
 */
export function fingerprintForLog(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

/**
 * Extract allowlisted metadata from a library error without recording its message.
 *
 * @param error The caught value.
 * @returns Safe error metadata suitable for logs.
 */
export function safeErrorMetadata(error: unknown): DiagnosticFields {
  if (!error || typeof error !== 'object') return { errorType: typeof error }

  const candidate = error as Record<string, unknown>
  const fields: Record<string, string> = {}
  for (const [source, target] of [
    ['name', 'errorName'],
    ['code', 'errorCode'],
    ['claim', 'claim'],
  ] as const) {
    const value = candidate[source]
    if (typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value)) {
      fields[target] = value
    }
  }
  return fields
}
