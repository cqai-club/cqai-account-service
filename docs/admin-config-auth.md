# 管理控制台与 Logto 鉴权约定

管理控制台继续使用 Logto 登录，不在 Account Service 内保存或校验用户密码。浏览器只携带 Logto API Access Token；Account Service 负责校验 JWT 的签名、issuer、audience、有效期、客户端和当前路由所需的 scope。Access Token 必须带有有限的 `exp` NumericDate；缺少有效 `exp` 的 bearer token 会被拒绝。

为了简化首次部署，`CORS_ALLOWED_ORIGINS` 和 `LOGTO_CLIENT_PLATFORM_MAP` 不再是启动必填项。它们可以留空，服务先以安全的空集合启动，再由同源管理页登录后配置；空集合期间跨域请求和未映射客户 Client 均拒绝。

## 管理员客户端

为管理控制台在 Logto 中创建独立的 SPA Application，并为 Account Service API Resource 分配独立权限：

- `config:read`：读取当前可编辑配置；
- `config:write`：修改配置。

服务端通过环境变量提供管理页发起 Logto 登录所需的 SPA Client ID 和回调地址：

```env
LOGTO_ADMIN_CLIENT_ID=account-admin-client-id
LOGTO_ADMIN_REDIRECT_URI=https://account-admin.example.com/callback
```

`LOGTO_ADMIN_CLIENT_ID` 必须是 Logto SPA 的 Application ID，仅用于构造授权请求，不作为访问白名单。管理权限由 Access Token 中的 `config:read` / `config:write` scope 决定。

## 路由级权限

普通 API 与管理 API 使用不同的 scope 策略：

| 路由 | 必需 scope | Client 限制 |
|---|---|---|
| `/api/account` | `LOGTO_REQUIRED_SCOPES`（通常 `ai:invoke`） | 客户端平台映射 |
| `/v1/*` | `LOGTO_REQUIRED_SCOPES`（通常 `ai:invoke`） | 客户端平台映射 |
| `GET /api/admin/config` | `config:read` | 必须包含有效客户端声明 |
| `PUT /api/admin/config` | `config:write` | 必须包含有效客户端声明 |

管理路由必须跳过普通 `ai:invoke` 中间件，再执行自己的策略。这样：

- 具有 `ai:invoke` 的普通用户不能读取或修改配置；
- 管理员不需要无关的 AI 权限；
- 缺少管理 scope 返回 `AUTH_SCOPE_FORBIDDEN`。

服务端不得接受浏览器传入的 `platform`，也不得把管理员 Token 解析为客户平台身份。

## 配置接口

### `GET /api/admin/config`

请求头：

```http
Authorization: Bearer <Logto API Access Token>
```

响应只包含可动态编辑字段和版本元数据：

```json
{
  "success": true,
  "data": {
    "version": 1,
    "updatedAt": "2026-09-03T00:00:00.000Z",
    "corsAllowedOrigins": [],
    "logtoRequiredScopes": ["ai:invoke"],
    "logtoClientPlatforms": {},
    "accountCacheTtlSeconds": 300,
    "maxRequestBodyBytes": 20971520,
    "persistence": {"enabled": false}
  }
}
```

### `PUT /api/admin/config`

请求体可包含上面字段和从 GET 响应取得的 `version`。服务端以版本号做乐观并发控制；版本过期返回 `CONFIG_VERSION_CONFLICT`，管理页应先重新读取。服务端只接受白名单字段，未知字段返回 `CONFIG_PATCH_INVALID`。

以下配置仍必须在启动环境中提供：

- `LOGTO_ISSUER`、`LOGTO_AUDIENCE`、`LOGTO_JWKS_URI`；
- 任何 Logto 管理客户端私密凭据或 NewAPI 用户 API Key。

`NEW_API_BASE_URL` 可在管理页动态修改并写入 runtime 配置文件。`NEW_API_INTERNAL_TOKEN` 必须由服务端环境或 Secret Manager 提供，绝不能通过浏览器提交；启动时可以暂时留空，但它不会出现在 GET/PUT 响应、错误消息、浏览器存储、URL、日志或 `CONFIG_STORE_PATH` 文件中。任一 NewAPI 配置缺失时，`/api/account` 和 `/v1/*` 会返回 `NEW_API_NOT_CONFIGURED`。配置文件使用原子替换与 `0600` 权限。该 JSON 存储适合单实例；多副本不要让多个进程直接共享同一文件，应使用外部配置存储/数据库，或把管理写入固定的单实例。

`CORS_ALLOWED_ORIGINS` 和 `LOGTO_CLIENT_PLATFORM_MAP` 可以不写入 `.env`。服务会以空集合启动：同源管理页仍可访问，跨域请求会被拒绝，未映射的客户 Client 会被拒绝；管理员登录后再从页面补齐配置。

### `POST /api/admin/config/validate`

这是可选的只验证接口，使用与 `PUT` 相同的请求体和 `config:write` 权限，但不会持久化或发布配置。服务端应返回校验结果和当前版本；页面可在保存前调用它。若部署版本未提供该接口，管理页可以提示用户直接保存，由 `PUT` 执行最终校验。

### `GET /admin/oidc-config`

独立管理页可读取此公开引导信息来发起 OIDC Authorization Code + PKCE：issuer、audience、管理员 SPA Client ID 和 redirect URI。此接口不返回 Client Secret、NewAPI 凭据或用户 Token。管理页不接受通过 URL query 覆盖服务地址或 OIDC 端点，避免带有会话 Token 的链接把凭据发送到未知来源。

授权请求和 authorization code 换 Token 的请求都会携带同一个 RFC 8707 `resource`（即 `LOGTO_AUDIENCE`），确保 Logto 返回绑定到 Account Service API Resource 的 Access Token。若换 Token 时漏传 `resource`，Logto 可能返回不带 audience 的普通 OIDC 不透明 Token；服务端必须拒绝这种 Token，不能通过跳过 audience 校验来兼容。管理页收到 401 时会清除当前会话中的失效 Token，并要求重新登录。

服务端在设置 `ADMIN_UI_DIR` 时会从该目录仅提供固定的 `index.html`、`main.js`、`oidc.js`、对应 source map 和 `styles.css`；未构建资源返回 404。该目录应只指向经过审核的 `apps/admin/dist` 构建产物。管理页会把 OIDC discovery endpoint 与 issuer 绑定；切换 issuer 或 Account Service 地址时会清理旧 endpoint 和 pending PKCE 交易，避免把授权码发送到旧服务。

若由 Account Service 同源托管构建后的静态页面，可设置可选环境变量 `ADMIN_UI_DIR` 指向 `apps/admin/dist`，然后访问 `/admin/`。服务端只暴露管理页构建清单内的固定文件；未构建时返回 404，不会把任意文件路径映射到浏览器。

## 发布前检查

至少验证以下情形：

1. 有效管理员 Token + `config:read` 可 GET 配置；
2. 有效管理员 Token + `config:write` 可 PUT 配置；
3. 仅有 `ai:invoke` 的 Token 被管理路由拒绝；
4. 具备 `config:*` scope 且 Token 校验通过的客户端可进入对应管理路由；
5. 管理路由身份固定为内部 `admin` 标记，不使用客户平台映射；
6. GET 配置、PUT 错误响应、OIDC 引导响应和持久化文件均不含 NewAPI 密钥。

本地验证：

```bash
npm run typecheck
npm test
npm run build
git diff --check
```
