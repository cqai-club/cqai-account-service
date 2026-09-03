# CQAI Account Service

CQAI Account Service 是 Logto 与 NewAPI 之间的账号桥接和 AI BFF。下游应用继续直接使用 Logto 登录，只把 Logto API Access Token 交给本服务；本服务在服务端解析用户、获取对应的 NewAPI Key，并代理 OpenAI 兼容请求。

```text
下游应用 ── Logto Access Token ──> Account Service ── NewAPI Key ──> NewAPI
```

浏览器不会接触 NewAPI Service Token 或完整 API Key，也不依赖跨域 Cookie。

## 项目结构

```text
apps/server/          Account/BFF 服务
apps/admin/           无依赖管理员配置控制台（静态构建产物在 apps/admin/dist）
packages/client-sdk/  面向浏览器应用的轻量 SDK
```

- `@cqaiclub/account-server` 使用 `@cqaiclub/cqai-account-sdk` 访问 NewAPI。
- `apps/admin` 是一个不依赖前端框架的静态管理页，通过 Logto 管理员 Access Token 调用 `/api/admin/config`；它只管理 NewAPI 地址，不接收或展示任何 NewAPI 密钥。
- `@cqaiclub/account-client` 只负责获取最新 Logto Token 和请求 Account Service，可后续独立发布。

## 当前状态

服务端已经包含：

- Logto JWT 的 JWKS 签名、issuer、audience、有效期、scope 校验。
- Logto Client ID 到内部 `platform` 的可信映射。
- 精确来源 CORS 白名单，不使用跨域 Cookie。
- `GET /api/account` 安全账号摘要，响应不包含 NewAPI Key。
- `/v1/*` 到 NewAPI 的请求代理和流式响应透传。
- 请求体大小限制、敏感请求头替换和敏感响应头过滤。
- 基于 Logto 管理员 Token 的运行配置管理 API，以及独立的静态管理控制台。

`cqai-relay` 已实现并注册 SDK 约定的 `POST /api/internal/provision`，由 `NEW_API_INTERNAL_TOKEN` 保护；接口合同见 [docs/new-api-provision-contract.md](docs/new-api-provision-contract.md)。部署时需在 NewAPI 与 Account Service 配置完全相同的内部密钥，并确保新用户额度大于 0。

## 本地启动

`@cqaiclub/cqai-account-sdk` 已发布到 npm，会随项目依赖自动安装。启动服务：

```bash
cd ../cqai-account-service
npm install
cp apps/server/.env.example apps/server/.env
npm run dev
```

默认监听 `http://localhost:8787`。

如需预览管理员配置页：

```bash
npm run build --workspace=@cqaiclub/account-admin
python3 -m http.server 4174 -d apps/admin/dist
```

打开 `http://localhost:4174/`，在页面中填写 Account Service 地址并注入 Logto 管理员 Access Token。完成根目录 `npm run build` 后，服务端也会默认把同一份产物挂在 `http://localhost:8787/admin/`；生产环境可将 `apps/admin/dist` 部署到独立的管理员域名，或由反向代理映射到 `/admin/`。具体接口、OIDC PKCE 登录和 CORS 接入说明见 [apps/admin/README.md](apps/admin/README.md)。

GitHub Actions 会同步 `cqai-account-service`，在服务器中通过 npm 安装依赖并执行 `npm ci && npm run build`。默认重启命令是 `systemctl restart cqai-account-service`，只有你想换成别的重启方式时才需要额外提供 `DEPLOY_COMMAND`。

需要的部署配置是：

- `DEPLOY_HOST`
- `DEPLOY_PORT`
- `DEPLOY_USER`
- `DEPLOY_SSH_KEY`
- `DEPLOY_PATH`
- `DEPLOY_COMMAND`（可选，默认 `systemctl restart cqai-account-service`）

## Logto 配置

1. 在 Logto 创建 API Resource，例如 `https://account.cqaiclub.asia`。
2. 为该资源创建 `ai:invoke` 权限，并通过角色分配给允许使用 AI 的用户。
3. 每个下游产品使用独立的 Logto SPA Application。
4. 下游应用请求上述 API Resource 的 Access Token。
5. 登录管理页后，将 SPA 的 Client ID 映射为固定平台名（也可以暂时留空，配置完成前客户 API 会拒绝未映射的 Client）：

```env
LOGTO_CLIENT_PLATFORM_MAP={"lingweave-logto-client-id":"lingweave","image-app-client-id":"image-app"}
```

不能接受浏览器传入的任意 `platform`，否则一个应用可能冒充另一个应用并使用其额度。

## 服务端配置

复制 [apps/server/.env.example](apps/server/.env.example) 后配置。NewAPI 两项可以留空，登录 `/admin/` 后再填写：

| 变量 | 用途 |
|---|---|
| `LOGTO_ISSUER` | Logto Token issuer，通常以 `/oidc` 结尾 |
| `LOGTO_AUDIENCE` | Account Service 对应的 API Resource indicator |
| `LOGTO_JWKS_URI` | Logto JWKS 地址，默认是 `${LOGTO_ISSUER}/jwks` |
| `LOGTO_REQUIRED_SCOPES` | 必须具备的权限，默认 `ai:invoke` |
| `LOGTO_CLIENT_PLATFORM_MAP` | 可选的 Logto Client ID 到平台名 JSON 初始值；也可在管理页配置 |
| `LOGTO_ADMIN_CLIENT_ID` | `/admin/` 发起 OIDC PKCE 登录时使用的 Logto SPA Application ID；访问权限由 `config:*` scope 决定 |
| `LOGTO_ADMIN_REDIRECT_URI` | 管理页 OIDC 回调地址（可选） |
| `CORS_ALLOWED_ORIGINS` | 可选的前端完整 Origin 初始值，逗号分隔；也可在管理页配置 |
| `NEW_API_BASE_URL` | NewAPI 服务地址，可在登录后的 `/admin/` 动态修改 |
| `NEW_API_INTERNAL_TOKEN` | provisioning 密钥；仅由服务端环境或 Secret Manager 提供 |
| `ACCOUNT_CACHE_TTL_SECONDS` | 用户 Key 的进程内缓存时间 |
| `MAX_REQUEST_BODY_BYTES` | 代理请求体上限 |
| `CONFIG_STORE_PATH` | 可选的运行配置 JSON 持久化路径；只保存安全的动态字段 |
| `ADMIN_UI_DIR` | 可选的已构建管理页面目录；默认使用仓库中的 `apps/admin/dist` |

`NEW_API_INTERNAL_TOKEN` 不得使用 `VITE_` 前缀，也不得提交到 Git，且不能通过浏览器管理页提交。

通过 Nginx 等反向代理终止 HTTPS 时，应保留原始 `Host` 请求头。服务会把浏览器的
`https://<Host>` Origin 与内部收到的 `http://<Host>` 请求视为同源；其他来源仍必须逐项配置在
`CORS_ALLOWED_ORIGINS` 中。

`CONFIG_STORE_PATH` 的 JSON 持久化是进程内串行、文件原子替换方案，适合单实例部署。多副本不要让多个服务进程直接共享同一个文件；请改用外部配置存储/数据库，或把管理写入固定的单实例。

## 管理控制台

管理控制台继续使用 Logto 登录，不在 Account Service 内保存密码。构建静态页面：

```bash
npm run build --workspace=@cqaiclub/account-admin
python3 -m http.server 4174 -d apps/admin/dist
```

将 `apps/admin/dist` 部署到独立的管理员域名，或由反向代理挂载到 `/admin/`。页面只调用：

- `GET /api/admin/config`（需要 `config:read`）；
- `POST /api/admin/config/validate`（需要 `config:write`，只校验不保存）；
- `PUT /api/admin/config`（需要 `config:write`）。

服务端会校验 Logto JWT 的签名、issuer、audience、有效期、客户端声明和路由 scope。具备 `config:read` / `config:write` 权限的有效 Token 可以访问对应管理接口。页面和接口不会回显 `NEW_API_INTERNAL_TOKEN`，也不会返回 NewAPI Service Token 或用户 API Key。完整合同见 [docs/admin-config-auth.md](docs/admin-config-auth.md) 和 [apps/admin/README.md](apps/admin/README.md)。

## 下游 SDK

在 LingWeave 中，将 Logto 的资源 Access Token 提供给客户端：

```ts
import { CqaiAccountClient } from '@cqaiclub/account-client'

const account = new CqaiAccountClient({
  baseUrl: 'https://account.cqaiclub.asia',
  getAccessToken: () => getAccessToken('https://account.cqaiclub.asia'),
})

const profile = await account.getAccount()
const response = await account.createChatCompletion({
  model: 'gpt-5',
  messages: [{ role: 'user', content: '你好' }],
  stream: true,
})

// response.body 保持为流，由应用现有的 SSE 解析逻辑消费。
```

也可以通过 `account.request('/v1/...')` 调用其他允许的 OpenAI 兼容路径。SDK 每次请求都会获取最新 Logto Token，并显式使用 `credentials: 'omit'`。

## 验证

```bash
npm run typecheck
npm test
npm run build
```
