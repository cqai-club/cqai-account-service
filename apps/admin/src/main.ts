type ConfigVersion = number | string

import {
  authorizationCodeTokenRequest,
  clearOidcEndpointsOnIssuerChange,
  normalizeOidcEndpoint,
  pendingLoginIssuerMatches,
  pendingLoginServiceOriginMatches,
  selectOidcEndpoints,
  shouldResetOidcForServiceChange,
} from './oidc.js'

interface PublicConfig {
  version?: ConfigVersion
  updatedAt?: string
  status?: string
  corsAllowedOrigins: string[]
  logtoRequiredScopes: string[]
  logtoClientPlatforms: Record<string, string>
  accountCacheTtlSeconds: number
  maxRequestBodyBytes: number
  newApiBaseUrl: string
}

interface OidcConfig {
  issuer?: string
  clientId?: string
  audience?: string
  scopes?: string[]
  authorizationEndpoint?: string
  tokenEndpoint?: string
  redirectUri?: string
}

interface PendingLogin {
  state: string
  codeVerifier: string
  issuer: string
  serviceOrigin: string
  tokenEndpoint: string
  clientId: string
  redirectUri: string
  audience?: string
}

interface MappingEntry {
  clientId: string
  platform: string
}

interface AdminState {
  token: string
  /** Origin to which the current token was explicitly bound for this page session. */
  tokenServiceOrigin?: string
  config?: PublicConfig
  version?: ConfigVersion
  mappings: MappingEntry[]
  oidc: OidcConfig
  busy: boolean
  /** Invalidates in-flight requests when the operator changes service/token. */
  epoch: number
}

class AdminApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'AdminApiError'
  }
}

const TOKEN_STORAGE_KEY = 'cqai.admin.access-token'
const OIDC_STORAGE_KEY = 'cqai.admin.oidc-config'
const LOGIN_STORAGE_KEY = 'cqai.admin.pending-login'

const state: AdminState = {
  token: readSession(TOKEN_STORAGE_KEY) ?? '',
  mappings: [],
  oidc: {},
  busy: false,
  epoch: 0,
}

const accessTokenInput = element<HTMLTextAreaElement>('access-token')
const serviceBaseInput = element<HTMLInputElement>('service-base-url')
const injectTokenButton = element<HTMLButtonElement>('inject-token')
const logtoLoginButton = element<HTMLButtonElement>('logto-login')
const clearTokenButton = element<HTMLButtonElement>('clear-token')
const authMessage = element<HTMLParagraphElement>('auth-message')
const configMessage = element<HTMLParagraphElement>('config-message')
const configForm = element<HTMLFormElement>('config-form')
const configLock = element<HTMLElement>('config-lock')
const accountCacheTtlInput = element<HTMLInputElement>('account-cache-ttl')
const maxRequestBodyInput = element<HTMLInputElement>('max-request-body-bytes')
const newApiBaseUrlInput = element<HTMLInputElement>('new-api-base-url')
const corsOriginsInput = element<HTMLTextAreaElement>('cors-allowed-origins')
const requiredScopesInput = element<HTMLTextAreaElement>('logto-required-scopes')
const mappingRows = element<HTMLTableSectionElement>('mapping-rows')
const mappingEmpty = element<HTMLParagraphElement>('mapping-empty')
const addMappingButton = element<HTMLButtonElement>('add-mapping')
const reloadConfigButton = element<HTMLButtonElement>('reload-config')
const validateConfigButton = element<HTMLButtonElement>('validate-config')
const saveConfigButton = element<HTMLButtonElement>('save-config')
const connectionBadge = element<HTMLSpanElement>('connection-badge')
const configVersionLabel = element<HTMLSpanElement>('config-version')
const tokenState = element<HTMLSpanElement>('token-state')
const metadataVersion = element<HTMLElement>('metadata-version')
const metadataUpdatedAt = element<HTMLElement>('metadata-updated-at')
const metadataStatus = element<HTMLElement>('metadata-status')
const metadataServiceUrl = element<HTMLElement>('metadata-service-url')
const issuerInput = element<HTMLInputElement>('logto-issuer')
const clientIdInput = element<HTMLInputElement>('logto-client-id')
const audienceInput = element<HTMLInputElement>('logto-audience')
const scopesInput = element<HTMLInputElement>('logto-scopes')

initialize()

async function initialize(): Promise<void> {
  loadInitialSettings()
  // A restored token is only trusted when the page also has the service URL it
  // was explicitly associated with. Without that record, fail closed instead
  // of guessing where the token may be sent.
  bindRestoredTokenToService()
  updateTokenUi()
  updateServiceMetadata()
  await loadOidcConfig()
  await handleLoginCallback()
  if (state.token) await loadConfig()
}

function loadInitialSettings(): void {
  // Do not accept service or OIDC endpoints from URL query parameters. A
  // crafted link must never redirect a previously stored admin token to an
  // attacker-controlled origin. Operators can enter a service address
  // explicitly, or provide the values through same-origin meta tags.
  const serviceUrl = firstNonEmpty(
    readSession('cqai.admin.service-base-url'),
    document.querySelector<HTMLMetaElement>('meta[name="cqai-service-base-url"]')?.content,
    window.location.protocol === 'http:' || window.location.protocol === 'https:' ? window.location.origin : '',
  )
  if (serviceUrl) serviceBaseInput.value = serviceUrl

  const issuer = firstNonEmpty(
    document.querySelector<HTMLMetaElement>('meta[name="cqai-logto-issuer"]')?.content,
  )
  const clientId = firstNonEmpty(
    document.querySelector<HTMLMetaElement>('meta[name="cqai-logto-client-id"]')?.content,
  )
  const audience = firstNonEmpty(
    document.querySelector<HTMLMetaElement>('meta[name="cqai-logto-audience"]')?.content,
  )
  if (issuer) issuerInput.value = issuer
  if (clientId) clientIdInput.value = clientId
  if (audience) audienceInput.value = audience

  const storedOidc = readSessionJson<OidcConfig>(OIDC_STORAGE_KEY)
  if (storedOidc) {
    state.oidc = { ...storedOidc }
    setInputIfEmpty(issuerInput, storedOidc.issuer)
    setInputIfEmpty(clientIdInput, storedOidc.clientId)
    setInputIfEmpty(audienceInput, storedOidc.audience)
    if (storedOidc.scopes?.length) scopesInput.value = storedOidc.scopes.join(' ')
  }
}

async function loadOidcConfig(): Promise<void> {
  let baseUrl: string
  try {
    baseUrl = serviceBaseUrl()
  } catch {
    return
  }
  const requestEpoch = state.epoch
  const requestedOrigin = new URL(baseUrl).origin
  try {
    const payload = await fetchPublicJson(new URL('/admin/oidc-config', `${baseUrl}/`))
    if (requestEpoch !== state.epoch || currentServiceOrigin() !== requestedOrigin) return
    const data = asRecord(unwrapData(payload))
    if (!data) return
    const remote = normalizeOidcConfig(data)
    state.oidc = remote.issuer
      ? { ...clearOidcEndpointsOnIssuerChange(state.oidc, remote.issuer), ...remote }
      : { ...state.oidc, ...remote }
    if (remote.issuer) issuerInput.value = remote.issuer
    if (remote.clientId) clientIdInput.value = remote.clientId
    if (remote.audience) audienceInput.value = remote.audience
    if (remote.scopes?.length) scopesInput.value = remote.scopes.join(' ')
    if (!remote.issuer || !remote.clientId) throw new Error('服务端登录配置不完整')
    persistOidcConfig()
  } catch {
    setMessage(authMessage, '无法读取 Logto 登录配置，请确认 Account Service 已重启后刷新页面。', 'error')
  }
}

async function handleLoginCallback(): Promise<void> {
  const query = new URLSearchParams(window.location.search)
  const error = query.get('error')
  const code = query.get('code')
  if (error) {
    // An authorization error invalidates the pending transaction. Do not keep
    // its issuer-specific token endpoint around for a later callback.
    removeSession(LOGIN_STORAGE_KEY)
    clearLoginQuery()
    setMessage(authMessage, `Logto 登录未完成：${query.get('error_description') ?? error}`, 'error')
    return
  }
  if (!code) return

  const pending = readSessionJson<PendingLogin>(LOGIN_STORAGE_KEY)
  const returnedState = query.get('state')
  clearLoginQuery()
  if (!pending || !returnedState || pending.state !== returnedState) {
    removeSession(LOGIN_STORAGE_KEY)
    setMessage(authMessage, 'Logto 回调状态校验失败，请重新发起登录。', 'error')
    return
  }
  let currentIssuer: string | undefined
  try {
    currentIssuer = normalizeHttpUrl(issuerInput.value, 'Logto Issuer')
  } catch {
    // A changed or cleared issuer invalidates the pending authorization code
    // and, importantly, prevents posting it to the old token endpoint.
    currentIssuer = undefined
  }
  if (
    !pendingLoginIssuerMatches(currentIssuer, pending.issuer)
    || !pendingLoginServiceOriginMatches(currentServiceOrigin(), pending.serviceOrigin)
  ) {
    removeSession(LOGIN_STORAGE_KEY)
    setMessage(authMessage, 'Logto 或 Account Service 地址已变更，请重新发起登录。', 'warning')
    return
  }
  const tokenEndpoint = normalizeOidcEndpoint(pending.tokenEndpoint)
  if (!tokenEndpoint) {
    removeSession(LOGIN_STORAGE_KEY)
    setMessage(authMessage, 'Logto token endpoint 无效，请重新发起登录。', 'warning')
    return
  }
  removeSession(LOGIN_STORAGE_KEY)

  setBusy(true)
  setMessage(authMessage, '正在向 Logto 换取 Access Token…', 'info')
  try {
    const body = authorizationCodeTokenRequest({
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      code,
      codeVerifier: pending.codeVerifier,
      ...(pending.audience ? { audience: pending.audience } : {}),
    })
    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      credentials: 'omit',
      cache: 'no-store',
    })
    const payload = await parseJsonResponse(response)
    const token = asString(asRecord(payload)?.access_token)
    if (!token) throw new AdminApiError('Logto 未返回 Access Token。', response.status)
    // The service address or issuer can change while the browser is waiting
    // for the token endpoint. Re-check both bindings before storing or using
    // the newly returned bearer token; otherwise a valid old-flow token could
    // be sent to the newly selected destination.
    let latestIssuer: string | undefined
    try {
      latestIssuer = normalizeHttpUrl(issuerInput.value, 'Logto Issuer')
    } catch {
      latestIssuer = undefined
    }
    if (
      !pendingLoginIssuerMatches(latestIssuer, pending.issuer)
      || !pendingLoginServiceOriginMatches(currentServiceOrigin(), pending.serviceOrigin)
    ) {
      throw new AdminApiError('Logto 或 Account Service 地址已变更，请重新发起登录。', 400, 'AUTH_LOGIN_CONTEXT_CHANGED')
    }
    setAccessToken(token)
    setMessage(authMessage, 'Logto 登录成功，正在读取配置…', 'success')
    await loadConfig()
  } catch (errorValue) {
    setMessage(authMessage, userFacingError(errorValue, 'Logto 登录失败'), 'error')
  } finally {
    setBusy(false)
  }
}

async function startLogtoLogin(): Promise<void> {
  let issuer: string
  let clientId: string
  try {
    issuer = normalizeHttpUrl(issuerInput.value, 'Logto Issuer')
    clientId = requireText(clientIdInput.value, 'Logto SPA Client ID')
  } catch (errorValue) {
    setMessage(authMessage, userFacingError(errorValue, '请补充 Logto 登录参数'), 'error')
    return
  }

  const loginEpoch = state.epoch
  setBusy(true)
    setMessage(authMessage, '正在读取 Logto OIDC 配置…', 'info')
  try {
    const serviceOrigin = currentServiceOrigin()
    if (!serviceOrigin) throw new Error('Account Service 地址无效')
    // Persist the selected service before leaving the page. This is required
    // for cross-origin static deployments: after Logto redirects back, the
    // callback page must restore the same service-origin binding that was
    // recorded in the pending PKCE transaction.
    persistServiceUrl()
    const discovery = await fetchDiscovery(issuer)
    let currentIssuer: string
    try {
      currentIssuer = normalizeHttpUrl(issuerInput.value, 'Logto Issuer')
    } catch {
      throw new Error('Logto Issuer 已变更，请重新发起登录。')
    }
    if (
      loginEpoch !== state.epoch
      || !pendingLoginIssuerMatches(currentIssuer, issuer)
      || currentServiceOrigin() !== serviceOrigin
    ) {
      throw new Error('Logto 或 Account Service 地址已变更，请重新发起登录。')
    }
    // Discovery belongs to the issuer the operator just selected. Cached
    // endpoints are accepted only when their issuer matches exactly; an
    // issuer change can therefore never reuse an old authorization endpoint.
    const { authorizationEndpoint, tokenEndpoint } = selectOidcEndpoints(issuer, discovery, state.oidc)
    if (!authorizationEndpoint || !tokenEndpoint) {
      throw new Error('Logto OIDC 配置缺少 authorization_endpoint 或 token_endpoint')
    }
    const redirectUri = normalizeRedirectUri(
      state.oidc.redirectUri || `${window.location.origin}${window.location.pathname}`,
    )
    const codeVerifier = randomBase64Url(48)
    const challenge = await pkceChallenge(codeVerifier)
    const loginState = randomBase64Url(24)
    const audience = audienceInput.value.trim() || state.oidc.audience
    const pending: PendingLogin = {
      state: loginState,
      codeVerifier,
      issuer,
      serviceOrigin,
      tokenEndpoint,
      clientId,
      redirectUri,
      ...(audience ? { audience } : {}),
    }
    writeSessionJson(LOGIN_STORAGE_KEY, pending)
    const scopes = parseWords(scopesInput.value || state.oidc.scopes?.join(' ') || 'openid config:read config:write')
    if (!scopes.includes('openid')) scopes.unshift('openid')
    const authorizeUrl = new URL(authorizationEndpoint)
    authorizeUrl.searchParams.set('response_type', 'code')
    authorizeUrl.searchParams.set('client_id', clientId)
    authorizeUrl.searchParams.set('redirect_uri', redirectUri)
    authorizeUrl.searchParams.set('scope', scopes.join(' '))
    authorizeUrl.searchParams.set('state', loginState)
    authorizeUrl.searchParams.set('code_challenge', challenge)
    authorizeUrl.searchParams.set('code_challenge_method', 'S256')
    if (audience) {
      authorizeUrl.searchParams.set('resource', audience)
      authorizeUrl.searchParams.set('audience', audience)
    }
    const loginConfig: OidcConfig = {
      issuer,
      clientId,
      scopes,
      authorizationEndpoint,
      tokenEndpoint,
      redirectUri,
      ...(audience ? { audience } : {}),
    }
    persistOidcConfig(loginConfig)
    window.location.assign(authorizeUrl.toString())
  } catch (errorValue) {
    removeSession(LOGIN_STORAGE_KEY)
    setBusy(false)
    setMessage(authMessage, userFacingError(errorValue, '无法发起 Logto 登录'), 'error')
  }
}

async function loadConfig(): Promise<void> {
  if (!state.token) {
    lockConfig('需要管理员 Access Token')
    return
  }
  const requestEpoch = state.epoch
  setBusy(true)
  setMessage(configMessage, '正在读取服务端配置…', 'info')
  setConnection('warning', '读取中')
  try {
  const payload = await requestJson('/api/admin/config')
    if (requestEpoch !== state.epoch || !state.token) return
    const config = normalizePublicConfig(payload)
    state.config = config
    if (config.version !== undefined) state.version = config.version
    else delete state.version
    populateConfig(config)
    setConnection('success', '已连接')
    setMessage(configMessage, '配置已读取。修改后点击“保存配置”提交。', 'success')
  } catch (errorValue) {
    if (requestEpoch !== state.epoch) return
    if (clearInvalidSession(errorValue)) return
    if (errorValue instanceof AdminApiError
      && (errorValue.status === 403 || errorValue.code === 'AUTH_SCOPE_FORBIDDEN')) {
      lockConfig('缺少 config:read 权限')
      setConnection('danger', '权限不足')
      setMessage(
        authMessage,
        'Logto 登录成功，但当前 Token 没有 config:read 权限。请在 Logto 为当前用户角色授权后退出并重新登录。',
        'warning',
      )
      setMessage(configMessage, '当前登录账号无权读取配置。', 'error')
      return
    }
    lockConfig('配置读取失败')
    setConnection('danger', '连接失败')
    setMessage(configMessage, userFacingError(errorValue, '读取配置失败'), 'error')
  } finally {
    if (requestEpoch === state.epoch) setBusy(false)
  }
}

async function validateConfig(): Promise<void> {
  if (!state.token) {
    setMessage(configMessage, '请先注入管理员 Access Token。', 'warning')
    return
  }
  let config: Record<string, unknown>
  try {
    config = collectConfig()
  } catch (errorValue) {
    setMessage(configMessage, userFacingError(errorValue, '当前配置无法验证'), 'error')
    return
  }
  const requestEpoch = state.epoch
  setBusy(true)
  setMessage(configMessage, '正在验证当前配置（不会保存）…', 'info')
  try {
    const payload = await requestJson('/api/admin/config/validate', {
      method: 'POST',
      body: JSON.stringify(withVersion(config)),
    })
    if (requestEpoch !== state.epoch || !state.token) return
    const result = asRecord(unwrapData(payload))
    const message = asString(result?.message) ?? '当前配置验证通过。'
    setMessage(configMessage, message, 'success')
  } catch (errorValue) {
    if (requestEpoch !== state.epoch) return
    if (clearInvalidSession(errorValue)) return
    if (errorValue instanceof AdminApiError && errorValue.status === 404) {
      setMessage(configMessage, '服务端暂未提供独立验证接口；可直接保存并由服务端校验。', 'warning')
    } else {
      setMessage(configMessage, userFacingError(errorValue, '配置验证失败'), 'error')
    }
  } finally {
    if (requestEpoch === state.epoch) setBusy(false)
  }
}

async function saveConfig(): Promise<void> {
  if (!state.token) {
    setMessage(configMessage, '请先注入管理员 Access Token。', 'warning')
    return
  }
  let config: Record<string, unknown>
  try {
    config = collectConfig()
  } catch (errorValue) {
    setMessage(configMessage, userFacingError(errorValue, '配置校验失败'), 'error')
    return
  }
  const requestEpoch = state.epoch
  setBusy(true)
  setMessage(configMessage, '正在保存配置…', 'info')
  try {
    const payload = await requestJson('/api/admin/config', {
      method: 'PUT',
      body: JSON.stringify(withVersion(config)),
    })
    if (requestEpoch !== state.epoch || !state.token) return
    const saved = normalizePublicConfig(payload)
    state.config = saved
    if (saved.version !== undefined) state.version = saved.version
    else delete state.version
    populateConfig(saved)
    setConnection('success', '已保存')
    setMessage(configMessage, '配置已保存并原子切换。', 'success')
  } catch (errorValue) {
    if (requestEpoch !== state.epoch) return
    if (clearInvalidSession(errorValue)) return
    if (errorValue instanceof AdminApiError && (errorValue.status === 409 || errorValue.code === 'CONFIG_VERSION_CONFLICT')) {
      setMessage(configMessage, '配置版本已变化，请先重新读取再保存。', 'warning')
    } else {
      setMessage(configMessage, userFacingError(errorValue, '保存配置失败'), 'error')
    }
  } finally {
    if (requestEpoch === state.epoch) setBusy(false)
  }
}

function populateConfig(config: PublicConfig): void {
  configLock.hidden = true
  configForm.hidden = false
  accountCacheTtlInput.value = String(config.accountCacheTtlSeconds)
  maxRequestBodyInput.value = String(config.maxRequestBodyBytes)
  newApiBaseUrlInput.value = config.newApiBaseUrl
  corsOriginsInput.value = config.corsAllowedOrigins.join('\n')
  requiredScopesInput.value = config.logtoRequiredScopes.join(' ')
  state.mappings = Object.entries(config.logtoClientPlatforms).map(([clientId, platform]) => ({ clientId, platform }))
  renderMappings()
  metadataVersion.textContent = displayValue(config.version)
  metadataUpdatedAt.textContent = formatDate(config.updatedAt)
  metadataStatus.textContent = config.status || '运行中'
  configVersionLabel.textContent = config.version === undefined ? '已读取' : `版本 ${String(config.version)}`
  updateServiceMetadata()
}

function lockConfig(reason: string): void {
  configLock.hidden = false
  configForm.hidden = true
  configLock.querySelector('h3')?.replaceChildren(document.createTextNode(reason))
  metadataVersion.textContent = '—'
  metadataUpdatedAt.textContent = '—'
  metadataStatus.textContent = state.token ? '读取失败' : '等待登录'
  configVersionLabel.textContent = '配置尚未读取'
}

function renderMappings(): void {
  mappingRows.replaceChildren()
  mappingEmpty.hidden = state.mappings.length > 0
  state.mappings.forEach((entry, index) => {
    const row = document.createElement('tr')
    const clientCell = document.createElement('td')
    const platformCell = document.createElement('td')
    const actionCell = document.createElement('td')
    const clientInput = document.createElement('input')
    const platformInput = document.createElement('input')
    const removeButton = document.createElement('button')

    clientInput.type = 'text'
    clientInput.autocomplete = 'off'
    clientInput.spellcheck = false
    clientInput.value = entry.clientId
    clientInput.placeholder = 'Logto Client ID'
    clientInput.setAttribute('aria-label', `第 ${index + 1} 行 Client ID`)
    clientInput.addEventListener('input', () => {
      const current = state.mappings[index]
      if (current) current.clientId = clientInput.value
    })

    platformInput.type = 'text'
    platformInput.autocomplete = 'off'
    platformInput.value = entry.platform
    platformInput.placeholder = '例如 lingweave'
    platformInput.setAttribute('aria-label', `第 ${index + 1} 行平台名`)
    platformInput.addEventListener('input', () => {
      const current = state.mappings[index]
      if (current) current.platform = platformInput.value
    })

    removeButton.type = 'button'
    removeButton.className = 'remove-mapping'
    removeButton.textContent = '移除'
    removeButton.addEventListener('click', () => {
      state.mappings.splice(index, 1)
      renderMappings()
    })

    clientCell.append(clientInput)
    platformCell.append(platformInput)
    actionCell.append(removeButton)
    row.append(clientCell, platformCell, actionCell)
    mappingRows.append(row)
  })
}

function collectConfig(): Record<string, unknown> {
  const accountCacheTtlSeconds = parseInteger(accountCacheTtlInput.value, '账号缓存时间', true)
  const maxRequestBodyBytes = parseInteger(maxRequestBodyInput.value, '最大请求体', false)
  const newApiBaseUrl = newApiBaseUrlInput.value.trim()
  validateNewApiBaseUrl(newApiBaseUrl)
  const corsAllowedOrigins = parseWords(corsOriginsInput.value)
  corsAllowedOrigins.forEach((origin) => validateOrigin(origin))
  if (corsAllowedOrigins.includes('*')) throw new Error('CORS 允许来源不能包含 *')

  const logtoRequiredScopes = parseWords(requiredScopesInput.value)
  if (logtoRequiredScopes.length === 0) throw new Error('至少填写一个 Logto 必要 Scope')
  const logtoClientPlatforms: Record<string, string> = Object.create(null) as Record<string, string>
  state.mappings.forEach((entry, index) => {
    const clientId = entry.clientId.trim()
    const platform = entry.platform.trim()
    if (!clientId) throw new Error(`第 ${index + 1} 行 Client ID 不能为空`)
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(platform) || platform.toLowerCase() === 'admin') {
      throw new Error(`第 ${index + 1} 行平台名格式无效`)
    }
    if (Object.prototype.hasOwnProperty.call(logtoClientPlatforms, clientId)) throw new Error(`Client ID 重复：${clientId}`)
    logtoClientPlatforms[clientId] = platform
  })
  return {
    newApiBaseUrl,
    accountCacheTtlSeconds,
    maxRequestBodyBytes,
    corsAllowedOrigins,
    logtoRequiredScopes,
    logtoClientPlatforms,
  }
}

function validateNewApiBaseUrl(value: string): void {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('NewAPI 地址必须是完整的 HTTP(S) 地址') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('NewAPI 地址不能包含凭据、查询参数或 fragment')
  }
}

function withVersion(config: Record<string, unknown>): Record<string, unknown> {
  return state.version === undefined ? config : { ...config, version: state.version }
}

function addMapping(): void {
  state.mappings.push({ clientId: '', platform: '' })
  renderMappings()
  const inputs = mappingRows.querySelectorAll<HTMLInputElement>('input')
  inputs[inputs.length - 2]?.focus()
}

function setAccessToken(token: string): void {
  state.epoch += 1
  state.token = token.trim()
  bindExplicitTokenToService()
  if (state.token) writeSession(TOKEN_STORAGE_KEY, state.token)
  else removeSession(TOKEN_STORAGE_KEY)
  accessTokenInput.value = ''
  updateTokenUi()
}

function clearAccessToken(): void {
  state.epoch += 1
  state.token = ''
  delete state.tokenServiceOrigin
  delete state.config
  delete state.version
  removeSession(TOKEN_STORAGE_KEY)
  removeSession(LOGIN_STORAGE_KEY)
  accessTokenInput.value = ''
  lockConfig('需要管理员 Access Token')
  setConnection('neutral', '未连接')
  setMessage(authMessage, '已退出，当前会话 Token 已清除。', 'info')
  setMessage(configMessage, '', 'info')
  setBusy(false)
  updateTokenUi()
}

function clearInvalidSession(errorValue: unknown): boolean {
  if (!(errorValue instanceof AdminApiError) || errorValue.status !== 401) return false
  clearAccessToken()
  setMessage(authMessage, '登录已失效，请重新使用 Logto 登录。', 'warning')
  return true
}

function updateTokenUi(): void {
  if (state.token) {
    tokenState.textContent = '已登录'
    tokenState.classList.add('ready')
    clearTokenButton.disabled = false
    clearTokenButton.hidden = false
    logtoLoginButton.hidden = true
    injectTokenButton.textContent = '更新 Token 并读取配置'
  } else {
    tokenState.textContent = '未登录'
    tokenState.classList.remove('ready')
    clearTokenButton.disabled = true
    clearTokenButton.hidden = true
    logtoLoginButton.hidden = false
    injectTokenButton.textContent = '注入 Token 并读取配置'
  }
}

function setBusy(value: boolean): void {
  state.busy = value
  injectTokenButton.disabled = value
  logtoLoginButton.disabled = value
  addMappingButton.disabled = value || !state.token
  reloadConfigButton.disabled = value || !state.token
  validateConfigButton.disabled = value || !state.token
  saveConfigButton.disabled = value || !state.token
}

function setConnection(kind: 'neutral' | 'success' | 'warning' | 'danger', label: string): void {
  connectionBadge.className = `status-badge status-${kind}`
  connectionBadge.textContent = label
}

function setMessage(target: HTMLElement, message: string, kind: 'info' | 'success' | 'warning' | 'error'): void {
  target.className = 'form-message'
  if (kind !== 'info') target.classList.add(kind)
  target.textContent = message
}

function updateServiceMetadata(): void {
  try {
    metadataServiceUrl.textContent = serviceBaseUrl()
  } catch {
    metadataServiceUrl.textContent = '未设置'
  }
}

function serviceBaseUrl(): string {
  return normalizeHttpUrl(serviceBaseInput.value, 'Account Service 地址')
}

function assertTokenServiceBinding(): void {
  const currentOrigin = currentServiceOrigin()
  if (currentOrigin && state.tokenServiceOrigin && currentOrigin === state.tokenServiceOrigin) return
  clearAccessToken()
  throw new AdminApiError(
    '服务地址已变更，已清除管理员 Token。',
    401,
    'AUTH_SERVICE_ORIGIN_CHANGED',
  )
}

async function requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
  if (!state.token) throw new AdminApiError('管理员 Access Token 不可用', 401, 'AUTH_TOKEN_REQUIRED')
  assertTokenServiceBinding()
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${state.token}`)
  headers.set('Accept', 'application/json')
  if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  let url: string
  try {
    url = new URL(path, `${serviceBaseUrl()}/`).toString()
  } catch (errorValue) {
    throw new Error(userFacingError(errorValue, 'Account Service 地址无效'))
  }
  persistServiceUrl()
  const response = await fetch(url, { ...init, headers, credentials: 'omit', cache: 'no-store' })
  const payload = await parseJsonResponse(response)
  if (!response.ok) {
    const data = asRecord(payload)
    throw new AdminApiError(
      asString(data?.message) ?? `请求失败（${response.status}）`,
      response.status,
      asString(data?.code),
    )
  }
  if (isRecord(payload) && payload.success === false) {
    throw new AdminApiError(asString(payload.message) ?? '服务端拒绝了请求', response.status, asString(payload.code))
  }
  return payload
}

async function fetchPublicJson(url: URL): Promise<unknown> {
  const response = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'omit', cache: 'no-store' })
  const payload = await parseJsonResponse(response)
  if (!response.ok) throw new AdminApiError(`登录配置请求失败（${response.status}）`, response.status)
  return payload
}

async function fetchDiscovery(issuer: string): Promise<Record<string, unknown>> {
  const discoveryUrl = new URL('.well-known/openid-configuration', `${issuer.replace(/\/$/, '')}/`)
  const payload = await fetchPublicJson(discoveryUrl)
  const data = asRecord(payload)
  if (!data) throw new Error('Logto OIDC 配置格式无效')
  return data
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    return { message: text.slice(0, 240) }
  }
}

function normalizePublicConfig(payload: unknown): PublicConfig {
  const envelope = asRecord(payload)
  const rawData = unwrapData(payload)
  const data = asRecord(rawData)
  if (!data) throw new Error('服务端返回的配置格式无效')
  const nested = asRecord(data.config) ?? data
  const version = firstVersion(data.version, envelope?.version)
  const updatedAt = firstNonEmpty(asString(data.updatedAt), asString(envelope?.updatedAt))
  const status = firstNonEmpty(asString(data.status), asString(envelope?.status))
  const origins = toStringArray(nested.corsAllowedOrigins)
  const scopes = toStringArray(nested.logtoRequiredScopes)
  const platforms = toStringMap(nested.logtoClientPlatforms)
  const accountCacheTtlSeconds = toFiniteNumber(nested.accountCacheTtlSeconds)
  const maxRequestBodyBytes = toFiniteNumber(nested.maxRequestBodyBytes)
  const newApiBaseUrl = asString(nested.newApiBaseUrl) ?? ''
  if (!scopes.length) throw new Error('服务端返回的配置缺少必要 Scope')
  if (accountCacheTtlSeconds === undefined || maxRequestBodyBytes === undefined) {
    throw new Error('服务端返回的数值配置无效')
  }
  const result: PublicConfig = {
    corsAllowedOrigins: origins,
    logtoRequiredScopes: scopes,
    logtoClientPlatforms: platforms,
    accountCacheTtlSeconds,
    maxRequestBodyBytes,
    newApiBaseUrl,
  }
  if (version !== undefined) result.version = version
  if (updatedAt) result.updatedAt = updatedAt
  if (status) result.status = status
  return result
}

function normalizeOidcConfig(data: Record<string, unknown>): OidcConfig {
  const result: OidcConfig = {}
  const issuer = firstNonEmpty(asString(data.issuer), asString(data.logtoIssuer))
  const clientId = firstNonEmpty(asString(data.clientId), asString(data.logtoClientId))
  const audience = firstNonEmpty(asString(data.audience), asString(data.logtoAudience))
  const scopes = toStringArray(data.scopes ?? data.logtoScopes)
  const authorizationEndpoint = firstNonEmpty(asString(data.authorizationEndpoint), asString(data.authorization_endpoint))
  const tokenEndpoint = firstNonEmpty(asString(data.tokenEndpoint), asString(data.token_endpoint))
  const redirectUri = firstNonEmpty(asString(data.redirectUri), asString(data.redirect_uri))
  if (issuer) result.issuer = issuer
  if (clientId) result.clientId = clientId
  if (audience) result.audience = audience
  if (scopes.length) result.scopes = scopes
  if (authorizationEndpoint) result.authorizationEndpoint = authorizationEndpoint
  if (tokenEndpoint) result.tokenEndpoint = tokenEndpoint
  if (redirectUri) result.redirectUri = redirectUri
  return result
}

function unwrapData(payload: unknown): unknown {
  const envelope = asRecord(payload)
  if (!envelope || !('data' in envelope)) return payload
  const data = envelope.data
  const record = asRecord(data)
  if (record && 'config' in record) return data
  return data
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
  if (typeof value === 'string') return parseWords(value)
  return []
}

function toStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const result: Record<string, string> = Object.create(null) as Record<string, string>
  Object.entries(value).forEach(([key, item]) => {
    if (typeof item === 'string' && key.trim()) result[key.trim()] = item.trim()
  })
  return result
}

function parseWords(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))]
}

function parseInteger(value: string, label: string, allowZero: boolean): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new Error(`${label}必须是${allowZero ? '非负' : '正'}整数`)
  }
  return parsed
}

function validateOrigin(value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`CORS 来源无效：${value}`)
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value.replace(/\/$/, '') || url.pathname !== '/') {
    throw new Error(`CORS 来源必须只包含协议和主机：${value}`)
  }
}

function normalizeHttpUrl(value: string, label: string): string {
  const raw = requireText(value, label)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${label}必须是完整的 HTTP(S) 地址`)
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label}必须是无凭据、无查询参数的 HTTP(S) 地址`)
  }
  return url.toString().replace(/\/$/, '')
}

function normalizeRedirectUri(value: string): string {
  let url: URL
  try {
    url = new URL(value, window.location.origin)
  } catch {
    throw new Error('Logto 回调地址无效')
  }
  if (
    url.origin !== window.location.origin
    || url.username
    || url.password
    || url.hash
  ) {
    throw new Error('Logto 回调地址必须与当前管理页同源，且不能包含凭据或 fragment')
  }
  return url.toString()
}

function requireText(value: string, label: string): string {
  const result = value.trim()
  if (!result) throw new Error(`${label}不能为空`)
  return result
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim()
}

function firstVersion(...values: Array<unknown>): ConfigVersion | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

function displayValue(value: unknown): string {
  return value === undefined || value === null || value === '' ? '—' : String(value)
}

function formatDate(value: string | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function userFacingError(errorValue: unknown, fallback: string): string {
  if (errorValue instanceof AdminApiError) {
    if (errorValue.code === 'AUTH_TOKEN_REQUIRED' || errorValue.status === 401) return '管理员 Token 无效或已过期，请重新登录。'
    if (errorValue.status === 403) return '当前 Token 没有配置管理权限。'
    return errorValue.message.slice(0, 240) || fallback
  }
  if (errorValue instanceof Error) return errorValue.message.slice(0, 240) || fallback
  return fallback
}

function persistServiceUrl(): void {
  try {
    writeSession('cqai.admin.service-base-url', serviceBaseUrl())
  } catch {
    // Validation errors are surfaced by the API operation itself.
  }
}

function persistOidcConfig(next?: OidcConfig): void {
  state.oidc = { ...state.oidc, ...(next ?? readOidcForm()) }
  writeSessionJson(OIDC_STORAGE_KEY, state.oidc)
}

function readOidcForm(): OidcConfig {
  const result: OidcConfig = {}
  const issuer = firstNonEmpty(issuerInput.value)
  const clientId = firstNonEmpty(clientIdInput.value)
  const audience = firstNonEmpty(audienceInput.value)
  const scopes = parseWords(scopesInput.value)
  if (issuer) result.issuer = issuer
  if (clientId) result.clientId = clientId
  if (audience) result.audience = audience
  if (scopes.length) result.scopes = scopes
  return result
}

function setInputIfEmpty(input: HTMLInputElement, value: string | undefined): void {
  if (value && !input.value.trim()) input.value = value
}

function clearLoginQuery(): void {
  // The admin page has no hash-based router. Drop fragments as well as the
  // authorization code/error so an IdP or malformed link cannot leave a
  // token-like value in the address bar or browser history.
  const cleanUrl = window.location.pathname
  window.history.replaceState({}, document.title, cleanUrl)
}

function randomBase64Url(size: number): string {
  const bytes = new Uint8Array(size)
  crypto.getRandomValues(bytes)
  let binary = ''
  bytes.forEach((byte) => { binary += String.fromCharCode(byte) })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

async function pkceChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier)
  const digest = await crypto.subtle.digest('SHA-256', data)
  const bytes = new Uint8Array(digest)
  let binary = ''
  bytes.forEach((byte) => { binary += String.fromCharCode(byte) })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readSession(key: string): string | undefined {
  try {
    const value = window.sessionStorage.getItem(key)
    return value || undefined
  } catch {
    return undefined
  }
}

function writeSession(key: string, value: string): void {
  try { window.sessionStorage.setItem(key, value) } catch { /* private browsing can reject storage */ }
}

function removeSession(key: string): void {
  try { window.sessionStorage.removeItem(key) } catch { /* private browsing can reject storage */ }
}

function readSessionJson<T>(key: string): T | undefined {
  const value = readSession(key)
  if (!value) return undefined
  try { return JSON.parse(value) as T } catch { removeSession(key); return undefined }
}

function writeSessionJson(key: string, value: unknown): void {
  try { writeSession(key, JSON.stringify(value)) } catch { /* non-critical preference */ }
}

function element<T extends HTMLElement>(id: string): T {
  const target = document.getElementById(id)
  if (!target) throw new Error(`Missing admin element: ${id}`)
  return target as T
}

injectTokenButton.addEventListener('click', () => {
  const token = accessTokenInput.value.trim()
  if (!token) {
    setMessage(authMessage, '请粘贴 Logto Access Token。', 'warning')
    return
  }
  persistServiceUrl()
  setAccessToken(token)
  setMessage(authMessage, 'Token 已注入当前会话。', 'success')
  void loadConfig()
})

logtoLoginButton.addEventListener('click', () => { void startLogtoLogin() })
clearTokenButton.addEventListener('click', clearAccessToken)
reloadConfigButton.addEventListener('click', () => { void loadConfig() })
validateConfigButton.addEventListener('click', () => { void validateConfig() })
addMappingButton.addEventListener('click', addMapping)
configForm.addEventListener('submit', (event) => {
  event.preventDefault()
  void saveConfig()
})
serviceBaseInput.addEventListener('change', handleServiceUrlChange)
issuerInput.addEventListener('change', handleIssuerChange)
clientIdInput.addEventListener('change', () => { persistOidcConfig() })
audienceInput.addEventListener('change', () => { persistOidcConfig() })
scopesInput.addEventListener('change', () => { persistOidcConfig() })

function handleServiceUrlChange(): void {
  const nextOrigin = currentServiceOrigin()
  // If the origin cannot be parsed, keep the token unusable and clear it on
  // the next valid change. A missing/invalid prior setting must never be
  // interpreted as permission to send a token to an arbitrary origin.
  const changedOrigin = state.tokenServiceOrigin === undefined
    ? Boolean(state.token)
    : nextOrigin !== state.tokenServiceOrigin
  persistServiceUrl()
  updateServiceMetadata()
  // Even without a token, changing the selected service must not leave the
  // previous service's OIDC client/audience/endpoint metadata in use for a
  // subsequent login. Invalidate in-flight metadata/discovery work and the
  // pending PKCE transaction before accepting the new service selection.
  if (shouldResetOidcForServiceChange(Boolean(state.token), changedOrigin)) {
    state.epoch += 1
    clearOidcSettings()
  }
  if (state.token && changedOrigin) {
    clearAccessToken()
    setMessage(authMessage, '服务地址已更改，出于安全需要请重新注入管理员 Token。', 'warning')
  }
  // Refresh public OIDC metadata for the newly selected service. If the
  // standalone page is hosted elsewhere, this is what makes the Logto login
  // button work without requiring the operator to copy every endpoint by hand.
  void loadOidcConfig()
}

function clearOidcSettings(): void {
  state.oidc = {}
  removeSession(OIDC_STORAGE_KEY)
  removeSession(LOGIN_STORAGE_KEY)
  issuerInput.value = ''
  clientIdInput.value = ''
  audienceInput.value = ''
  scopesInput.value = ''
}

function currentServiceOrigin(): string | undefined {
  try {
    return new URL(serviceBaseUrl()).origin
  } catch {
    return undefined
  }
}

function bindRestoredTokenToService(): void {
  if (!state.token) return
  const persistedServiceUrl = readSession('cqai.admin.service-base-url')
  const origin = currentServiceOrigin()
  if (!persistedServiceUrl || !origin) {
    // A token without an explicit service binding is ambiguous. Remove it
    // rather than risk sending a stale bearer credential to a newly selected
    // origin after a page reload.
    state.token = ''
    removeSession(TOKEN_STORAGE_KEY)
    delete state.tokenServiceOrigin
    return
  }
  state.tokenServiceOrigin = origin
}

function bindExplicitTokenToService(): void {
  const origin = currentServiceOrigin()
  if (origin) state.tokenServiceOrigin = origin
  else delete state.tokenServiceOrigin
}

function handleIssuerChange(): void {
  state.epoch += 1
  const nextIssuer = issuerInput.value.trim() || undefined
  if (nextIssuer) {
    state.oidc = {
      ...state.oidc,
      ...clearOidcEndpointsOnIssuerChange(state.oidc, nextIssuer),
    }
  } else {
    delete state.oidc.issuer
    delete state.oidc.authorizationEndpoint
    delete state.oidc.tokenEndpoint
  }
  persistOidcConfig()
}
