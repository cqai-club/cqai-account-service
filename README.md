# CQAI Account Service

CQAI Account Service 是 Logto 与 NewAPI 之间的账号桥接和 AI BFF。下游应用继续直接使用 Logto 登录，只把 Logto API Access Token 交给本服务；本服务在服务端解析用户、获取对应的 NewAPI Key，并代理 OpenAI 兼容请求。

```text
下游应用 ── Logto Access Token ──> Account Service ── NewAPI Key ──> NewAPI
```

浏览器不会接触 NewAPI Service Token 或完整 API Key，也不依赖跨域 Cookie。

## 项目结构

```text
apps/server/          Account/BFF 服务
packages/client-sdk/  面向浏览器应用的轻量 SDK
```

- `@cqaiclub/account-server` 使用 `@cqaiclub/cqai-account-sdk` 访问 NewAPI。
- `@cqaiclub/account-client` 只负责获取最新 Logto Token 和请求 Account Service。

## 当前状态

服务端已经包含：

- Logto JWT 的 JWKS 签名、issuer、audience、有效期、scope 校验。
- Logto Client ID 到内部 `platform` 的可信映射。
- 精确来源 CORS 白名单，不使用跨域 Cookie。
- `GET /api/account` 安全账号摘要，响应不包含 NewAPI Key。
- `/v1/*` 到 NewAPI 的请求代理和流式响应透传。
- 请求体大小限制、敏感请求头替换和敏感响应头过滤。
- 可选 Redis 缓存；未配置 `REDIS_URL` 时使用进程内存缓存，Key 以 AES-256-GCM 加密后写入 Redis。

`cqai-relay` 已实现并注册 SDK 约定的 `POST /api/internal/provision`，由 `NEW_API_INTERNAL_TOKEN` 保护；接口合同见 [docs/new-api-provision-contract.md](docs/new-api-provision-contract.md)。

## 配置方式

本项目不提供运行时管理页。所有服务端配置来自环境变量，生产环境统一由 GitHub Actions Repository Variables 和 Secrets 在部署时写入以下文件：

```text
apps/server/.env.actions
```

该文件权限为 `0600`、不会提交到 Git，启动时覆盖 `.env` 中的同名旧值。

### GitHub Actions Secrects

以下值必须放在 Repository Secrets，绝不能放进 Variables、日志或仓库文件：

- `DEPLOY_HOST`
- `DEPLOY_PORT`
- `DEPLOY_USER`
- `DEPLOY_SSH_KEY`
- `DEPLOY_PATH`
- `DEPLOY_COMMAND`（可选，默认 `systemctl restart cqai-account-service`）
- `NEW_API_INTERNAL_TOKEN`（必填，使用 Relay 生成的内部 Token）
- `REDIS_URL`（可选，例如 `redis://:<password>@127.0.0.1:6380/0`）

其中 `DEPLOY_HOST`、`DEPLOY_PORT`、`DEPLOY_USER`、`DEPLOY_PATH`、`DEPLOY_SSH_KEY`
放在 `production` 环境的 Secrets 中；`DEPLOY_COMMAND` 和 `NEW_API_INTERNAL_TOKEN`
可放在仓库级 Secrets。

### GitHub Actions Variables

Repository Variables 至少需要配置：

- `LOGTO_ISSUER`
- `LOGTO_AUDIENCE`
- `CORS_ALLOWED_ORIGINS`
- `LOGTO_CLIENT_PLATFORM_MAP`

可选变量及其默认值：

- `LOGTO_JWKS_URI`（不设置时取 `${LOGTO_ISSUER}/jwks`）
- `LOGTO_REQUIRED_SCOPES`（默认 `ai:invoke`）
- `ACCOUNT_CACHE_TTL_SECONDS`（默认 `300`）
- `MAX_REQUEST_BODY_BYTES`（默认 `20971520`）
- `NEW_API_BASE_URL`

示例：

```text
CORS_ALLOWED_ORIGINS=https://cqai-club.github.io
LOGTO_CLIENT_PLATFORM_MAP={"l0odswrhnwfu31ikpa5bb":"lingweave"}
```

## Logto 配置

1. 在 Logto 创建 API Resource，例如 `https://account.cqaiclub.asia`。
2. 为该资源创建 `ai:invoke` 权限，并通过角色分配给允许使用 AI 的用户。
3. 每个下游产品使用独立的 Logto SPA Application。
4. 下游应用请求上述 API Resource 的 Access Token。
5. 将 SPA 的 Client ID 通过 `LOGTO_CLIENT_PLATFORM_MAP` 映射为固定平台名。

```env
LOGTO_CLIENT_PLATFORM_MAP={"lingweave-logto-client-id":"lingweave","image-app-client-id":"image-app"}
```

不能接受浏览器传入的任意 `platform`，否则一个应用可能冒充另一个应用并使用其额度。

## 服务端配置

复制 [apps/server/.env.example](apps/server/.env.example) 后配置。生产部署时这些值由 GitHub Actions 写入 `.env.actions`，不要手工编辑服务器上的文件。

| 变量 | 用途 |
|---|---|
| `PORT` | 监听端口，默认 `8787` |
| `LOGTO_ISSUER` | Logto Token issuer，通常以 `/oidc` 结尾 |
| `LOGTO_AUDIENCE` | Account Service 对应的 API Resource indicator |
| `LOGTO_JWKS_URI` | JWKS 地址，通常由 issuer 推导 |
| `LOGTO_REQUIRED_SCOPES` | 调用所需 scope，默认 `ai:invoke` |
| `LOGTO_CLIENT_PLATFORM_MAP` | Client ID 到 platform 的 JSON 映射 |
| `CORS_ALLOWED_ORIGINS` | 允许跨域的浏览器来源 |
| `NEW_API_BASE_URL` | NewAPI 服务端地址（业务接口未配置时返回 503） |
| `NEW_API_INTERNAL_TOKEN` | NewAPI provisioning 内部令牌（不能为空、不能写入变量） |
| `REDIS_URL` | 可选 Redis 地址；未配置时使用进程内存缓存 |
| `ACCOUNT_CACHE_TTL_SECONDS` | 账号与应用 Key 缓存秒数，默认 300 |
| `MAX_REQUEST_BODY_BYTES` | 代理请求体上限，默认 20971520 |

## Redis 缓存

启用可选 Redis 后，Account Service 会把 `(issuer, subject, platform)` 对应的账号资料和 NewAPI Key 写入 Redis。缓存值使用 AES-256-GCM 加密，Redis 中不会出现完整 Key 的明文；加密密钥从 `NEW_API_INTERNAL_TOKEN` 派生。Redis 临时不可用时自动回退到进程内存缓存，业务请求不会因缓存故障失败。

部署前建议按 [docs/redis-cache.md](docs/redis-cache.md) 启动独立 Redis 容器，并只绑定本机回环地址。

## 本地启动

```bash
npm install
cp apps/server/.env.example apps/server/.env
npm run dev
```

默认监听 `http://localhost:8787`。

## 发布前检查

```bash
npm run typecheck
npm test
npm run build
git diff --check
```
