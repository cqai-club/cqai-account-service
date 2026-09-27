import { createHash, createHmac, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { NewApiHttpClient, AiAccountError } from '@cqaiclub/cqai-account-sdk'
import { ServiceError } from './errors.js'
import type { ResolvedAccount, VerifiedIdentity } from './types.js'

export interface VideoConfig {
  database: string
  inferflowUrl: string
  inferflowKey: string
  relayUrl: string
  maxUploadBytes: number
}
export function videoConfig(env = process.env): VideoConfig | undefined {
  if (env.EJIANBAO_ENABLED !== '1') return undefined
  const url = new URL(env.INFERFLOW_BASE_URL || 'https://saas.inferflow.dev/openapi/v1')
  if (!env.INFERFLOW_API_KEY || !env.EJIANBAO_DATABASE || !env.NEW_API_BASE_URL
    || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new ServiceError('Managed video configuration is incomplete', 500, 'VIDEO_CONFIG_INVALID')
  }
  return {database: env.EJIANBAO_DATABASE, inferflowUrl: url.href.replace(/\/$/, ''), inferflowKey: env.INFERFLOW_API_KEY,
    relayUrl: env.NEW_API_BASE_URL, maxUploadBytes: 50 * 1024 ** 2}
}
type Quote = {id: string; owner: string; scriptHash: string; amount: number; quotaPerUnit: number; estimatedSeconds: number; pricingSource: 'relay'; expiresAt: string}
type RelayQuote = {quota: number; quotaPerUnit: number; seconds: number}
type Run = {id: string; owner: string; fingerprint: string; quoteId: string; createdAt: number; phase: 'preparing' | 'submitting' | 'submitted' | 'failed'; taskId?: string}
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const safeId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new ServiceError('Invalid video identifier', 400, 'VIDEO_INVALID')
  return value
}
function owner(identity: VerifiedIdentity): string {return hash(JSON.stringify([identity.issuer, identity.subject, identity.platform]))}
function scriptText(value: unknown): string {
  const text = typeof value === 'string' ? value.replace(/\r\n?/g, '\n') : ''
  if (!text.trim() || text.length > 5000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new ServiceError('Invalid video script', 400, 'VIDEO_INVALID')
  return text.trim()
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ServiceError('Invalid service response', 502, 'VIDEO_UPSTREAM_INVALID')
  return value as Record<string, unknown>
}

/** Durable idempotency and ownership; Relay owns job polling and wallet accounting. */
export class VideoService {
  private readonly db: DatabaseSync
  constructor(readonly config: VideoConfig, private readonly request: typeof fetch = fetch) {
    if (config.database !== ':memory:') mkdirSync(dirname(config.database), {recursive: true})
    this.db = new DatabaseSync(config.database)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS video_quotes (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS video_runs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_key TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(owner,request_key));')
  }
  close() {this.db.close()}
  private async relayQuote(account: ResolvedAccount, seconds: number): Promise<RelayQuote> {
    let response: Record<string, unknown>
    try {
      response = await this.relay().request<Record<string, unknown>>('/v1/tasks/ejianbao/quote', {
        method: 'POST', apiKey: account.apiKey, body: {model: 'ejianbao-digitalhuman', seconds},
      })
    } catch {
      // A failed or rate-limited Relay lookup must never fall back to local pricing.
      throw new ServiceError('Relay video quote is unavailable', 503, 'VIDEO_QUOTE_UNAVAILABLE')
    }
    const quota = response.quota
    const quotaPerUnit = response.quota_per_unit
    const quotedSeconds = response.seconds
    if (!Number.isSafeInteger(quota) || Number(quota) < 0 || !Number.isSafeInteger(quotaPerUnit)
      || Number(quotaPerUnit) <= 0 || quotedSeconds !== seconds) {
      throw new ServiceError('Relay returned an invalid video quote', 502, 'VIDEO_UPSTREAM_INVALID')
    }
    return {quota: Number(quota), quotaPerUnit: Number(quotaPerUnit), seconds}
  }
  async quote(identity: VerifiedIdentity, input: unknown, account: ResolvedAccount) {
    const script = scriptText(object(input).script)
    const seconds = Math.min(1800, Math.max(10, Math.ceil(Array.from(script).length / 3)))
    const priced = await this.relayQuote(account, seconds)
    const quote: Quote = {id: randomUUID(), owner: owner(identity), scriptHash: hash(script), estimatedSeconds: seconds,
      amount: priced.quota, quotaPerUnit: priced.quotaPerUnit, pricingSource: 'relay', expiresAt: new Date(Date.now() + 10 * 60000).toISOString()}
    this.db.prepare('INSERT INTO video_quotes VALUES (?,?)').run(quote.id, JSON.stringify(quote))
    const perUnit = quote.quotaPerUnit
    let displayAmount: string | undefined
    const usd = quote.amount / perUnit
    if (account.quotaDisplayType === 'USD') displayAmount = '$' + usd.toFixed(4)
    if (account.quotaDisplayType === 'CNY' && account.usdExchangeRate && Number.isFinite(account.usdExchangeRate) && account.usdExchangeRate > 0) displayAmount = '¥' + (usd * account.usdExchangeRate).toFixed(4)
    if (account.quotaDisplayType === 'CUSTOM' && account.customCurrencyExchangeRate && Number.isFinite(account.customCurrencyExchangeRate) && account.customCurrencyExchangeRate > 0) displayAmount = (usd * account.customCurrencyExchangeRate).toFixed(4) + ' 积分'
    return {id: quote.id, amount: quote.amount, unit: '额度单位（预计预扣）', expiresAt: quote.expiresAt,
      estimatedSeconds: quote.estimatedSeconds, pricingSource: quote.pricingSource, ...(displayAmount ? {displayAmount} : {})}
  }
  private readRun(identity: VerifiedIdentity, id: string): Run {
    const row = this.db.prepare('SELECT data FROM video_runs WHERE id=? AND owner=?').get(safeId(id), owner(identity))
    if (!row) throw new ServiceError('Video task not found', 404, 'VIDEO_NOT_FOUND')
    return JSON.parse(String(row.data)) as Run
  }
  private save(run: Run) {this.db.prepare('UPDATE video_runs SET data=? WHERE id=?').run(JSON.stringify(run), run.id)}
  private relay() {
    return new NewApiHttpClient({baseUrl: this.config.relayUrl, fetch: (url, init) => this.request(url, {...init, redirect: 'error'}), timeoutMs: 120000})
  }
  async create(identity: VerifiedIdentity, account: ResolvedAccount, requestKey: string, form: FormData) {
    safeId(requestKey)
    const script = scriptText(form.get('script')); const quoteId = safeId(form.get('quoteId'))
    const files = [form.get('avatar'), form.get('voice')]
    const bytes: Uint8Array[] = []
    for (const file of files) {
      if (!(file instanceof File) || file.size === 0 || file.size > this.config.maxUploadBytes) throw new ServiceError('Invalid video material', 400, 'VIDEO_INVALID_MATERIAL')
      bytes.push(new Uint8Array(await file.arrayBuffer()))
    }
    const [avatar, voice] = files as File[]
    const image = bytes[0]!; const audio = bytes[1]!
    const imageOK = image[0] === 0xff && image[1] === 0xd8 || Buffer.from(image.subarray(0, 8)).equals(Buffer.from([137,80,78,71,13,10,26,10])) || Buffer.from(image.subarray(0,4)).toString() === 'RIFF' && Buffer.from(image.subarray(8,12)).toString() === 'WEBP'
    const audioOK = /\.(wav|m4a|mp3|ogg)$/i.test(voice!.name) && (Buffer.from(audio.subarray(0,4)).toString() === 'RIFF' || Buffer.from(audio.subarray(4,8)).toString() === 'ftyp' || Buffer.from(audio.subarray(0,3)).toString() === 'ID3' || audio[0] === 0xff && (audio[1]! & 0xe0) === 0xe0 || Buffer.from(audio.subarray(0,4)).toString() === 'OggS')
    if (!imageOK || !audioOK) throw new ServiceError('Unreadable image or audio format', 400, 'VIDEO_INVALID_MATERIAL')
    const subject = owner(identity); const fingerprint = hash(JSON.stringify([script, quoteId, hash(image), hash(audio)]))
    const existing = this.db.prepare('SELECT data FROM video_runs WHERE owner=? AND request_key=?').get(subject, requestKey)
    if (existing) {
      const run = JSON.parse(String(existing.data)) as Run
      if (run.fingerprint !== fingerprint) throw new ServiceError('Idempotency key content changed', 409, 'VIDEO_CONFLICT')
      return this.status(identity, account, run.id)
    }
    const row = this.db.prepare('SELECT data FROM video_quotes WHERE id=?').get(quoteId)
    const quote = row ? JSON.parse(String(row.data)) as Quote : undefined
    const expiresAt = quote && typeof quote.expiresAt === 'string' ? Date.parse(quote.expiresAt) : NaN
    if (!quote || quote.pricingSource !== 'relay' || quote.owner !== subject || quote.scriptHash !== hash(script)
      || !Number.isSafeInteger(quote.amount) || quote.amount < 0 || !Number.isSafeInteger(quote.quotaPerUnit) || quote.quotaPerUnit <= 0
      || !Number.isSafeInteger(quote.estimatedSeconds) || quote.estimatedSeconds < 10 || quote.estimatedSeconds > 1800
      || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new ServiceError('Quote expired or content changed', 409, 'VIDEO_QUOTE_EXPIRED')
    const currentPrice = await this.relayQuote(account, quote.estimatedSeconds)
    if (currentPrice.quota !== quote.amount || currentPrice.quotaPerUnit !== quote.quotaPerUnit) {
      throw new ServiceError('Video price changed; request a new quote', 409, 'VIDEO_QUOTE_CHANGED')
    }
    // This is only an early UX check. Relay performs authoritative atomic reservation.
    const available = account.tokenUnlimitedQuota === false && account.tokenQuota !== undefined ? Math.min(account.quota ?? Infinity, account.tokenQuota) : account.quota
    if (available !== undefined && available < quote.amount) throw new ServiceError('Insufficient quota', 402, 'VIDEO_QUOTA_LOW')
    const run: Run = {id: randomUUID(), owner: subject, fingerprint, quoteId, createdAt: Date.now(), phase: 'preparing'}
    // UNIQUE(owner,request_key) also arbitrates concurrent service processes.
    try {this.db.prepare('INSERT INTO video_runs VALUES (?,?,?,?)').run(run.id, subject, requestKey, JSON.stringify(run))}
    catch {throw new ServiceError('Video submission is already in progress', 409, 'VIDEO_CONFLICT')}
    try {
      const avatarId = await this.upload('avatars', avatar!, run.id + '-avatar')
      const voiceId = await this.upload('voices', voice!, run.id + '-voice')
      if (expiresAt <= Date.now()) {
        run.phase = 'failed'; this.save(run)
        throw new ServiceError('Quote expired during material upload', 409, 'VIDEO_QUOTE_EXPIRED')
      }
      const envelope = JSON.stringify({avatar_id: avatarId, voice_id: voiceId, script_text: script, seconds: quote.estimatedSeconds, request_id: run.id})
      const signature = createHmac('sha256', this.config.inferflowKey).update(envelope).digest('hex')
      run.phase = 'submitting'; this.save(run)
      const response = await this.relay().request<Record<string, unknown>>('/v1/tasks/ejianbao', {method: 'POST', apiKey: account.apiKey,
        body: {model: 'ejianbao-digitalhuman', envelope, signature, expected_quota: quote.amount}})
      run.taskId = safeId(response.task_id); run.phase = 'submitted'; this.save(run)
      return {id: run.id, status: 'queued', progress: 0}
    } catch (error) {
      if (run.phase === 'failed' && error instanceof ServiceError && error.code === 'VIDEO_QUOTE_EXPIRED') throw error
      if (run.phase === 'submitting' && error instanceof AiAccountError && error.status === 409 && error.code === 'task_quote_changed') {
        run.phase = 'failed'; this.save(run)
        throw new ServiceError('Video price changed; request a new quote', 409, 'VIDEO_QUOTE_CHANGED')
      }
      if (run.phase === 'submitting' && error instanceof AiAccountError && [401, 402, 403, 404, 413, 422, 429].includes(error.status)) {
        run.phase = 'failed'; this.save(run)
        throw new ServiceError('Relay rejected video submission', error.status === 402 ? 402 : 502, error.status === 402 ? 'VIDEO_QUOTA_LOW' : 'VIDEO_SUBMISSION_REJECTED')
      }
      if (run.phase === 'preparing') {run.phase = 'failed'; this.save(run)}
      // Once a create was sent, loss of acknowledgement must not trigger a second paid submission.
      throw new ServiceError(run.phase === 'submitting' ? 'Submission outcome requires reconciliation; do not create again' : 'Video material upload failed', 502, run.phase === 'submitting' ? 'VIDEO_SUBMISSION_UNKNOWN' : 'VIDEO_UPLOAD_FAILED')
    }
  }
  private async upload(kind: 'avatars' | 'voices', file: File, key: string): Promise<string> {
    const form = new FormData(); form.set('file', file, file.name); form.set('name', 'ejianbao-' + key); form.set('authorization_confirmed', 'true')
    const response = await this.request(`${this.config.inferflowUrl}/digital-human/${kind}`, {method: 'POST', headers: {'X-API-Key': this.config.inferflowKey, 'Idempotency-Key': key}, body: form, redirect: 'error', signal: AbortSignal.timeout(120000)})
    if (!response.ok) {await response.body?.cancel(); throw new Error('upload failed')}
    const data = object(await response.json()); return safeId(data[kind === 'avatars' ? 'avatar_id' : 'voice_id'])
  }
  async status(identity: VerifiedIdentity, account: ResolvedAccount, id: string) {
    const run = this.readRun(identity, id)
    if (run.phase === 'submitting') throw new ServiceError('Submission outcome requires reconciliation; do not create again', 409, 'VIDEO_SUBMISSION_UNKNOWN')
    if (run.phase === 'preparing' && (!run.createdAt || Date.now() - run.createdAt > 10 * 60000)) throw new ServiceError('Material preparation was interrupted; operator review required', 409, 'VIDEO_PREPARATION_INTERRUPTED')
    if (!run.taskId) return {id, status: run.phase === 'failed' ? 'failed' : 'queued', progress: 0}
    const data = await this.relay().request<Record<string, unknown>>(`/v1/tasks/${safeId(run.taskId)}`, {apiKey: account.apiKey})
    const status = data.status === 'SUCCESS' ? 'completed' : data.status === 'FAILURE' ? 'failed' : data.status === 'NOT_START' || data.status === 'QUEUED' ? 'queued' : 'generating'
    const progress = Number(String(data.progress ?? '0').replace('%', ''))
    return {id, status, progress: status === 'completed' ? 100 : Number.isFinite(progress) ? Math.max(0, Math.min(progress, 99)) : 0}
  }
  async download(identity: VerifiedIdentity, account: ResolvedAccount, id: string): Promise<Response> {
    const run = this.readRun(identity, id)
    if (!run.taskId || (await this.status(identity, account, id)).status !== 'completed') throw new ServiceError('Video not ready', 409, 'VIDEO_NOT_READY')
    // SDK is JSON-only. Like the existing /v1 proxy, content uses a fixed authenticated streaming path.
    const response = await this.request(`${this.config.relayUrl}/v1/tasks/${safeId(run.taskId)}/artifacts/video/content`, {headers: {Authorization: `Bearer ${account.apiKey}`}, redirect: 'error', signal: AbortSignal.timeout(120000)})
    if (!response.ok || !response.headers.get('content-type')?.startsWith('video/')) {await response.body?.cancel(); throw new ServiceError('Video download failed', 502, 'VIDEO_DOWNLOAD_FAILED')}
    return new Response(response.body, {headers: {'content-type': 'video/mp4', 'cache-control': 'no-store'}})
  }
  cancel(identity: VerifiedIdentity, id: string): never {
    this.readRun(identity, id)
    throw new ServiceError('Cloud generation cannot be cancelled through this relay; it continues in the background', 409, 'VIDEO_CANNOT_CANCEL')
  }
}
