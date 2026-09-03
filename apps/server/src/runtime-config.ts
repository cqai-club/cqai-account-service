import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

import type { ServiceConfig } from './config.js'
import { ServiceError } from './errors.js'

/**
 * The subset of service configuration that can be changed while the process is
 * running. Logto bootstrap authentication metadata remains fixed. The NewAPI
 * base URL is safe to persist. NewAPI credentials remain bootstrap-only and
 * never appear in the public view or browser-facing patch contract.
 */
export interface DynamicConfig {
  newApiBaseUrl: string
  corsAllowedOrigins: ReadonlySet<string>
  logtoRequiredScopes: readonly string[]
  logtoClientPlatforms: ReadonlyMap<string, string>
  accountCacheTtlMs: number
  maxRequestBodyBytes: number
}

/** A runtime snapshot with an optimistic-concurrency version. */
export interface RuntimeConfigSnapshot extends DynamicConfig {
  version: number
  updatedAt: string
}

/**
 * JSON-friendly representation used by the management API.  No bootstrap
 * secrets are included in this type or in the persisted representation.
 */
export interface PublicRuntimeConfig {
  version: number
  updatedAt: string
  corsAllowedOrigins: string[]
  logtoRequiredScopes: string[]
  logtoClientPlatforms: Record<string, string>
  accountCacheTtlSeconds: number
  maxRequestBodyBytes: number
  newApiBaseUrl: string
  persistence: {
    enabled: boolean
  }
}

type StringListPatch = string | readonly string[] | ReadonlySet<string>
type ClientPlatformMapPatch = string | ReadonlyMap<string, string> | Record<string, string>
type IntegerPatch = number | string

/**
 * A partial, JSON-friendly runtime configuration update.  `accountCacheTtlMs`
 * is accepted as an internal alias for server-side callers; public clients
 * should use `accountCacheTtlSeconds`.
 */
export interface RuntimeConfigPatch {
  newApiBaseUrl?: string
  corsAllowedOrigins?: StringListPatch
  logtoRequiredScopes?: StringListPatch
  logtoClientPlatforms?: ClientPlatformMapPatch
  accountCacheTtlSeconds?: IntegerPatch
  accountCacheTtlMs?: IntegerPatch
  maxRequestBodyBytes?: IntegerPatch
}

export interface RuntimeConfigStoreOptions {
  /** Absolute or process-relative JSON file path. Omit for in-memory mode. */
  path?: string | undefined
  /** Injectable clock for deterministic tests. */
  clock?: (() => Date) | undefined
}

interface PersistedRuntimeConfig {
  schemaVersion: 1
  version: number
  updatedAt: string
  corsAllowedOrigins: string[]
  logtoRequiredScopes: string[]
  logtoClientPlatforms: Record<string, string>
  accountCacheTtlSeconds: number
  maxRequestBodyBytes: number
  newApiBaseUrl?: string
}

const PLATFORM_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/i
const PERSISTED_SCHEMA_VERSION = 1 as const

/**
 * Resolve the optional persistence path from the process environment. An
 * empty value deliberately means in-memory mode, which is the safe default
 * for local development and ephemeral deployments.
 */
export function runtimeConfigStorePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.CONFIG_STORE_PATH?.trim()
  if (!raw) return undefined
  return isAbsolute(raw) ? raw : resolve(raw)
}

/**
 * Runtime configuration storage with atomic file replacement and serialized
 * updates. The constructor is synchronous and starts with the bootstrap
 * values; call `load()` (or `RuntimeConfigStore.fromConfig()`) before serving
 * requests to restore a persisted snapshot.
 */
export class RuntimeConfigStore {
  private readonly initialConfig: ServiceConfig
  private readonly filePath: string | undefined
  private readonly clock: () => Date
  private state: RuntimeConfigSnapshot
  private mutationQueue: Promise<void> = Promise.resolve()
  private loaded = false

  constructor(initialConfig: ServiceConfig, options: RuntimeConfigStoreOptions | string = {}) {
    const normalizedOptions: RuntimeConfigStoreOptions = typeof options === 'string' ? { path: options } : options
    this.initialConfig = cloneServiceConfig(initialConfig)
    const configuredPath = normalizedOptions.path?.trim()
    this.filePath = configuredPath
      ? (isAbsolute(configuredPath) ? configuredPath : resolve(configuredPath))
      : undefined
    this.clock = normalizedOptions.clock ?? (() => new Date())
    this.state = snapshotFromDynamic(toDynamicConfig(this.initialConfig), 1, this.now())
    // With no persistence source the bootstrap snapshot is already complete;
    // only file-backed stores need an explicit asynchronous load.
    this.loaded = this.filePath === undefined
  }

  /** Construct and restore a store in one awaitable operation. */
  static async fromConfig(
    initialConfig: ServiceConfig,
    options: RuntimeConfigStoreOptions | string = {},
  ): Promise<RuntimeConfigStore> {
    const store = new RuntimeConfigStore(initialConfig, options)
    await store.load()
    return store
  }

  /**
   * Restore the persisted snapshot, if configured and present. Calling this
   * more than once is supported and intentionally reloads the current file.
   */
  async load(): Promise<RuntimeConfigSnapshot> {
    const operation = this.mutationQueue.then(async () => {
      const persisted = await this.readPersisted()
      if (persisted) {
        this.state = snapshotFromPersisted(persisted, this.initialConfig)
      }
      this.loaded = true
      return cloneSnapshot(this.state)
    })
    this.mutationQueue = operation.then(() => undefined, () => undefined)
    return operation
  }

  /** Return a defensive copy of the current dynamic snapshot. */
  getSnapshot(): RuntimeConfigSnapshot {
    return cloneSnapshot(this.state)
  }

  /** Whether `load()` has completed at least once. */
  isLoaded(): boolean {
    return this.loaded
  }

  /**
   * Return a complete ServiceConfig for request handlers. Bootstrap values,
   * including the NewAPI internal token, stay in memory only.
   */
  getConfig(): ServiceConfig {
    const dynamic = this.getSnapshot()
    return {
      ...cloneServiceConfig(this.initialConfig),
      corsAllowedOrigins: dynamic.corsAllowedOrigins,
      logtoRequiredScopes: dynamic.logtoRequiredScopes,
      logtoClientPlatforms: dynamic.logtoClientPlatforms,
      newApiBaseUrl: dynamic.newApiBaseUrl,
      accountCacheTtlMs: dynamic.accountCacheTtlMs,
      maxRequestBodyBytes: dynamic.maxRequestBodyBytes,
    }
  }

  /** JSON-safe, secret-free view for the management UI/API. */
  getPublicConfig(snapshot?: RuntimeConfigSnapshot): PublicRuntimeConfig {
    const current = snapshot ? cloneSnapshot(snapshot) : this.getSnapshot()
    return {
      version: current.version,
      updatedAt: current.updatedAt,
      corsAllowedOrigins: [...current.corsAllowedOrigins],
      logtoRequiredScopes: [...current.logtoRequiredScopes],
      logtoClientPlatforms: Object.fromEntries(current.logtoClientPlatforms),
      accountCacheTtlSeconds: current.accountCacheTtlMs / 1000,
      maxRequestBodyBytes: current.maxRequestBodyBytes,
      newApiBaseUrl: current.newApiBaseUrl,
      persistence: { enabled: this.filePath !== undefined },
    }
  }

  /**
   * Validate a prospective update without persisting or publishing it. The
   * returned snapshot keeps the current version so callers can display a
   * preview while another update may still win the race before PUT.
   */
  preview(patch: RuntimeConfigPatch, expectedVersion?: number): RuntimeConfigSnapshot {
    if (expectedVersion !== undefined && !isPositiveSafeInteger(expectedVersion)) {
      throw new ServiceError('Configuration version must be a positive integer', 400, 'CONFIG_VERSION_INVALID')
    }
    if (expectedVersion !== undefined && expectedVersion !== this.state.version) {
      throw new ServiceError('Configuration has changed; reload and try again', 409, 'CONFIG_VERSION_CONFLICT')
    }
    return snapshotFromDynamic(mergePatch(cloneDynamicConfig(this.state), patch), this.state.version, this.state.updatedAt)
  }

  /**
   * Validate, persist, and publish an update. Operations are serialized so
   * concurrent callers observe deterministic version checks. If persistence
   * fails, the in-memory snapshot is left untouched.
   */
  update(patch: RuntimeConfigPatch, expectedVersion?: number): Promise<RuntimeConfigSnapshot> {
    if (expectedVersion !== undefined && !isPositiveSafeInteger(expectedVersion)) {
      return Promise.reject(new ServiceError('Configuration version must be a positive integer', 400, 'CONFIG_VERSION_INVALID'))
    }

    // Avoid overwriting an existing persisted snapshot when a caller updates
    // immediately after construction but before explicitly awaiting load().
    if (this.filePath && !this.loaded) {
      return this.load().then(() => this.update(patch, expectedVersion))
    }

    const operation = this.mutationQueue.then(async () => {
      if (expectedVersion !== undefined && expectedVersion !== this.state.version) {
        throw new ServiceError('Configuration has changed; reload and try again', 409, 'CONFIG_VERSION_CONFLICT')
      }
      if (this.state.version >= Number.MAX_SAFE_INTEGER) {
        throw new ServiceError('Configuration version limit has been reached', 500, 'CONFIG_VERSION_INVALID')
      }
      const nextDynamic = mergePatch(cloneDynamicConfig(this.state), patch)
      const next = snapshotFromDynamic(nextDynamic, this.state.version + 1, this.now())
      await this.persist(next)
      this.state = next
      this.loaded = true
      return cloneSnapshot(next)
    })
    this.mutationQueue = operation.then(() => undefined, () => undefined)
    return operation
  }

  private now(): string {
    const value = this.clock()
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new ServiceError('Configuration clock returned an invalid date', 500, 'CONFIG_STORE_INVALID')
    }
    return value.toISOString()
  }

  private async readPersisted(): Promise<PersistedRuntimeConfig | undefined> {
    if (!this.filePath) return undefined
    let text: string
    try {
      text = await fs.readFile(this.filePath, 'utf8')
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return undefined
      throw new ServiceError('Runtime configuration could not be read', 500, 'CONFIG_STORE_READ_FAILED')
    }
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      throw new ServiceError('Runtime configuration file is invalid', 500, 'CONFIG_STORE_INVALID')
    }
    return parsePersisted(value)
  }

  private async persist(snapshot: RuntimeConfigSnapshot): Promise<void> {
    if (!this.filePath) return
    const directory = dirname(this.filePath)
    let temporaryPath: string | undefined
    const payload = JSON.stringify(toPersisted(snapshot), null, 2) + '\n'
    try {
      temporaryPath = `${this.filePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
      await fs.mkdir(directory, { recursive: true })
      await fs.writeFile(temporaryPath, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await fs.rename(temporaryPath, this.filePath)
    } catch {
      throw new ServiceError('Runtime configuration could not be saved', 500, 'CONFIG_STORE_WRITE_FAILED')
    } finally {
      if (temporaryPath) await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }
}

function toDynamicConfig(config: ServiceConfig): DynamicConfig {
  return {
    newApiBaseUrl: config.newApiBaseUrl,
    corsAllowedOrigins: new Set(config.corsAllowedOrigins),
    logtoRequiredScopes: [...config.logtoRequiredScopes],
    logtoClientPlatforms: new Map(config.logtoClientPlatforms),
    accountCacheTtlMs: config.accountCacheTtlMs,
    maxRequestBodyBytes: config.maxRequestBodyBytes,
  }
}

function cloneServiceConfig(config: ServiceConfig): ServiceConfig {
  return {
    ...config,
    corsAllowedOrigins: new Set(config.corsAllowedOrigins),
    logtoRequiredScopes: [...config.logtoRequiredScopes],
    logtoClientPlatforms: new Map(config.logtoClientPlatforms),
  }
}

function snapshotFromDynamic(dynamic: DynamicConfig, version: number, updatedAt: string): RuntimeConfigSnapshot {
  return {
    ...cloneDynamicConfig(dynamic),
    version,
    updatedAt,
  }
}

function cloneDynamicConfig(dynamic: DynamicConfig): DynamicConfig {
  return {
    newApiBaseUrl: dynamic.newApiBaseUrl,
    corsAllowedOrigins: new Set(dynamic.corsAllowedOrigins),
    logtoRequiredScopes: [...dynamic.logtoRequiredScopes],
    logtoClientPlatforms: new Map(dynamic.logtoClientPlatforms),
    accountCacheTtlMs: dynamic.accountCacheTtlMs,
    maxRequestBodyBytes: dynamic.maxRequestBodyBytes,
  }
}

function cloneSnapshot(snapshot: RuntimeConfigSnapshot): RuntimeConfigSnapshot {
  return {
    ...cloneDynamicConfig(snapshot),
    version: snapshot.version,
    updatedAt: snapshot.updatedAt,
  }
}

function mergePatch(current: DynamicConfig, patch: RuntimeConfigPatch): DynamicConfig {
  if (!isPlainObject(patch)) invalidPatch('configuration update must be an object')
  const allowed = new Set([
    'newApiBaseUrl',
    'corsAllowedOrigins',
    'logtoRequiredScopes',
    'logtoClientPlatforms',
    'accountCacheTtlSeconds',
    'accountCacheTtlMs',
    'maxRequestBodyBytes',
  ])
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) invalidPatch('configuration contains a field that is not editable')
  }

  const source = patch as Record<string, unknown>
  const next: DynamicConfig = cloneDynamicConfig(current)
  if ('newApiBaseUrl' in source) {
    next.newApiBaseUrl = parseNewApiBaseUrl(source.newApiBaseUrl)
  }
  if ('corsAllowedOrigins' in source) {
    next.corsAllowedOrigins = parseOriginsPatch(source.corsAllowedOrigins)
  }
  if ('logtoRequiredScopes' in source) {
    next.logtoRequiredScopes = parseScopesPatch(source.logtoRequiredScopes)
  }
  if ('logtoClientPlatforms' in source) {
    next.logtoClientPlatforms = parseClientPlatformsPatch(source.logtoClientPlatforms)
  }

  const hasSeconds = 'accountCacheTtlSeconds' in source
  const hasMilliseconds = 'accountCacheTtlMs' in source
  if (hasSeconds && hasMilliseconds) {
    invalidPatch('provide only one of accountCacheTtlSeconds or accountCacheTtlMs')
  }
  if (hasSeconds) {
    const seconds = parseNonNegativeInteger(source.accountCacheTtlSeconds, 'accountCacheTtlSeconds')
    if (seconds > Math.floor(Number.MAX_SAFE_INTEGER / 1000)) {
      invalidPatch('accountCacheTtlSeconds is too large')
    }
    next.accountCacheTtlMs = seconds * 1000
  } else if (hasMilliseconds) {
    const milliseconds = parseNonNegativeInteger(source.accountCacheTtlMs, 'accountCacheTtlMs')
    if (milliseconds % 1000 !== 0) invalidPatch('accountCacheTtlMs must be a whole number of seconds')
    next.accountCacheTtlMs = milliseconds
  }
  if ('maxRequestBodyBytes' in source) {
    next.maxRequestBodyBytes = parsePositiveInteger(source.maxRequestBodyBytes, 'maxRequestBodyBytes')
  }
  return next
}

function parsePersisted(value: unknown): PersistedRuntimeConfig {
  if (!isPlainObject(value)) invalidStored('runtime configuration must be a JSON object')
  const source = value as Record<string, unknown>
  const allowedKeys = new Set([
    'schemaVersion',
    'version',
    'updatedAt',
    'corsAllowedOrigins',
    'logtoRequiredScopes',
    'logtoClientPlatforms',
    'logtoAdminClientIds',
    'accountCacheTtlSeconds',
    'maxRequestBodyBytes',
    'newApiBaseUrl',
  ])
  for (const key of Object.keys(source)) {
    if (!allowedKeys.has(key)) invalidStored('runtime configuration contains an unsupported field')
  }
  if (source.schemaVersion !== PERSISTED_SCHEMA_VERSION) {
    invalidStored('runtime configuration schema version is unsupported')
  }
  const version = parseStoredPositiveInteger(source.version, 'version')
  const updatedAt = parseStoredDate(source.updatedAt)
  let corsAllowedOrigins: string[]
  let logtoRequiredScopes: string[]
  let logtoClientPlatforms: Record<string, string>
  let accountCacheTtlSeconds: number
  let maxRequestBodyBytes: number
  let newApiBaseUrl: string | undefined
  try {
    corsAllowedOrigins = [...parseOriginsPatch(source.corsAllowedOrigins)]
    logtoRequiredScopes = [...parseScopesPatch(source.logtoRequiredScopes)]
    logtoClientPlatforms = Object.fromEntries(parseClientPlatformsPatch(source.logtoClientPlatforms))
    accountCacheTtlSeconds = parseNonNegativeInteger(source.accountCacheTtlSeconds, 'accountCacheTtlSeconds')
    maxRequestBodyBytes = parsePositiveInteger(source.maxRequestBodyBytes, 'maxRequestBodyBytes')
    if (source.newApiBaseUrl !== undefined) newApiBaseUrl = parseNewApiBaseUrl(source.newApiBaseUrl)
  } catch (error) {
    if (error instanceof ServiceError && error.code === 'CONFIG_PATCH_INVALID') {
      throw new ServiceError(error.message, 500, 'CONFIG_STORE_INVALID')
    }
    throw error
  }
  if (accountCacheTtlSeconds > Math.floor(Number.MAX_SAFE_INTEGER / 1000)) {
    invalidStored('accountCacheTtlSeconds is too large')
  }
  return {
    schemaVersion: PERSISTED_SCHEMA_VERSION,
    version,
    updatedAt,
    corsAllowedOrigins,
    logtoRequiredScopes,
    logtoClientPlatforms,
    accountCacheTtlSeconds,
    maxRequestBodyBytes,
    ...(newApiBaseUrl ? { newApiBaseUrl } : {}),
  }
}

function snapshotFromPersisted(value: PersistedRuntimeConfig, initialConfig: ServiceConfig): RuntimeConfigSnapshot {
  return snapshotFromDynamic(
    {
      corsAllowedOrigins: new Set(value.corsAllowedOrigins),
      logtoRequiredScopes: [...value.logtoRequiredScopes],
      logtoClientPlatforms: new Map(Object.entries(value.logtoClientPlatforms)),
      accountCacheTtlMs: value.accountCacheTtlSeconds * 1000,
      maxRequestBodyBytes: value.maxRequestBodyBytes,
      newApiBaseUrl: value.newApiBaseUrl ?? initialConfig.newApiBaseUrl,
    },
    value.version,
    value.updatedAt,
  )
}

function toPersisted(snapshot: RuntimeConfigSnapshot): PersistedRuntimeConfig {
  return {
    schemaVersion: PERSISTED_SCHEMA_VERSION,
    version: snapshot.version,
    updatedAt: snapshot.updatedAt,
    corsAllowedOrigins: [...snapshot.corsAllowedOrigins],
    logtoRequiredScopes: [...snapshot.logtoRequiredScopes],
    logtoClientPlatforms: Object.fromEntries(snapshot.logtoClientPlatforms),
    accountCacheTtlSeconds: snapshot.accountCacheTtlMs / 1000,
    maxRequestBodyBytes: snapshot.maxRequestBodyBytes,
    newApiBaseUrl: snapshot.newApiBaseUrl,
  }
}

function parseNewApiBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) invalidPatch('newApiBaseUrl is required')
  let url: URL
  try {
    url = new URL((value as string).trim())
  } catch {
    invalidPatch('newApiBaseUrl must be an absolute URL')
  }
  if (!['http:', 'https:'].includes(url!.protocol) || url!.username || url!.password || url!.search || url!.hash) {
    invalidPatch('newApiBaseUrl must be an HTTP(S) URL without credentials, query, or hash')
  }
  return url!.toString().replace(/\/$/, '')
}

function parseOriginsPatch(value: unknown): Set<string> {
  const values = parseStringList(value, 'corsAllowedOrigins', true)
  const origins = new Set<string>()
  for (const item of values) {
    if (item === '*') invalidPatch('corsAllowedOrigins must not contain *')
    let url: URL
    try {
      url = new URL(item)
    } catch {
      invalidPatch('corsAllowedOrigins contains an invalid origin')
    }
    if (!['http:', 'https:'].includes(url!.protocol) || url!.origin !== item.replace(/\/$/, '')) {
      invalidPatch('corsAllowedOrigins entries must contain only scheme and host')
    }
    origins.add(url!.origin)
  }
  return origins
}

function parseScopesPatch(value: unknown): string[] {
  const values = parseStringList(value, 'logtoRequiredScopes')
  if (values.length === 0) invalidPatch('logtoRequiredScopes must not be empty')
  return values
}

function parseClientPlatformsPatch(value: unknown): Map<string, string> {
  let source: unknown = value
  if (value instanceof Map) {
    source = Object.fromEntries(value)
  }
  if (typeof value === 'string') {
    try {
      source = JSON.parse(value)
    } catch {
      invalidPatch('logtoClientPlatforms must be a JSON object')
    }
  }
  if (!isPlainObject(source)) invalidPatch('logtoClientPlatforms must be a JSON object')
  const result = new Map<string, string>()
  for (const [clientId, platform] of Object.entries(source as Record<string, unknown>)) {
    const normalizedClientId = clientId.trim()
    if (
      !normalizedClientId
      || typeof platform !== 'string'
      || !PLATFORM_PATTERN.test(platform.trim())
      || platform.trim().toLowerCase() === 'admin'
    ) {
      invalidPatch('logtoClientPlatforms contains an invalid entry')
    }
    if (result.has(normalizedClientId)) invalidPatch('logtoClientPlatforms contains duplicate client IDs')
    result.set(normalizedClientId, (platform as string).trim())
  }
  return result
}

function parseStringList(value: unknown, field: string, allowEmpty = false): string[] {
  if (typeof value === 'string') {
    const result = [...new Set(value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))]
    if (result.length === 0 && !allowEmpty) invalidPatch(`${field} must not be empty`)
    return result
  }
  if (value instanceof Set) {
    const result: string[] = []
    for (const item of value) {
      if (typeof item !== 'string' || !item.trim()) invalidPatch(`${field} must contain non-empty strings`)
      const normalized = item.trim()
      if (!result.includes(normalized)) result.push(normalized)
    }
    if (result.length === 0 && !allowEmpty) invalidPatch(`${field} must not be empty`)
    return result
  }
  if (!Array.isArray(value)) invalidPatch(`${field} must be a string array`)
  const result: string[] = []
  for (const item of value as unknown[]) {
    if (typeof item !== 'string' || !item.trim()) invalidPatch(`${field} must contain non-empty strings`)
    const normalized = (item as string).trim()
    if (!result.includes(normalized)) result.push(normalized)
  }
  if (result.length === 0 && !allowEmpty) invalidPatch(`${field} must not be empty`)
  return result
}

function parseNonNegativeInteger(value: unknown, field: string): number {
  const parsed = parseInteger(value, field)
  if (parsed < 0) invalidPatch(`${field} must be a non-negative integer`)
  return parsed
}

function parsePositiveInteger(value: unknown, field: string): number {
  const parsed = parseInteger(value, field)
  if (parsed <= 0) invalidPatch(`${field} must be a positive integer`)
  return parsed
}

function parseInteger(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(parsed)) invalidPatch(`${field} must be an integer`)
  return parsed
}

function parseStoredPositiveInteger(value: unknown, field: string): number {
  const parsed = parseStoredInteger(value, field)
  if (parsed <= 0) invalidStored(`${field} must be a positive integer`)
  return parsed
}

function parseStoredInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalidStored(`${field} must be an integer`)
  return value
}

function parseStoredDate(value: unknown): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) invalidStored('updatedAt must be an ISO date')
  return new Date(value).toISOString()
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function invalidPatch(message: string): never {
  throw new ServiceError(message, 400, 'CONFIG_PATCH_INVALID')
}

function invalidStored(message: string): never {
  throw new ServiceError(message, 500, 'CONFIG_STORE_INVALID')
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}
