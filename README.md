# CQAI Account Service

CQAI Account Service 是 Logto 与 NewAPI 之间的账号桥接和 AI BFF。下游应用继续直接使用 Logto 登录，只把 Logto API Access Token 交给本服务；本服务在服务端解析用户、获取对应的 NewAPI Key，并代理 OpenAI 兼容请求。

```text
下游应用 ── Logto Access Token ──> Account Service ── NewAPI Key ──> NewAPI
```

浏览器业务流不会接触 NewAPI Service Token 或完整 API Key，也不依赖跨域 Cookie。受信任客户端如明确采用 CC Switch 直连模式，可通过 `/api/client-credential` 在一次受保护交换中取得用户平台 Key；取得后 Key 的生命周期由 Relay/NewAPI 控制。

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
- 从已验证 Access Token 读取 email、username/preferred_username 和 name，用于 Relay 首次 provisioning，不额外调用 UserInfo。
- 精确来源 CORS 白名单，不使用跨域 Cookie。
- `GET /api/account` 安全账号摘要，包含已验证的用户姓名、用户名、邮箱和账号额度，响应不包含 NewAPI Key。
- `GET /api/client-credential` 面向受信任客户端的凭证交换接口，要求 Logto Access Token 且拒绝带 `Origin` 的浏览器请求；返回 Relay 地址和该用户的平台 API Key。
- `GET/POST /api/billing/*` 面向 Logto 用户的支付门面，转发充值和订阅操作到 Relay；浏览器不会接触 NewAPI 登录态、Service Token 或 API Key。
- `/v1/*` 到 NewAPI 的请求代理和流式响应透传。
- 请求体大小限制、敏感请求头替换和敏感响应头过滤。
- 可选 Redis 缓存；未配置 `REDIS_URL` 时使用进程内存缓存，Key 以 AES-256-GCM 加密后写入 Redis。

`cqai-relay` 已实现并注册 SDK 约定的 `POST /api/internal/provision`，由 `NEW_API_INTERNAL_TOKEN` 保护；接口合同见 [docs/new-api-provision-contract.md](docs/new-api-provision-contract.md)。
在当前单一 Logto issuer 下，Relay 会通过 `users.oidc_id == subject` 让原生 OIDC 登录与 Account Service provisioning 复用同一本地用户；管理面 Session 与业务 Access Token 仍保持独立。

### 支付门面

浏览器使用 `@cqaiclub/account-client` 的 `getTopUpInfo`、`listTopUps`、`createTopUp`、
`getSubscriptionPlans`、`getSubscriptionSelf` 和 `purchaseSubscription` 方法。充值先从
`getTopUpInfo()` 获取 Account Service 归一化的 `payment_options`，再提交 `payment_option_id`；请求只携带 Logto
Access Token 和经过白名单校验的支付参数；Account Service 从已验证身份解析 NewAPI 用户后，通过
`NEW_API_INTERNAL_TOKEN` 调用 Relay 的 `/api/internal/payment/*`。支付渠道配置、订单记录、webhook
验签以及充值/订阅入账仍由 Relay 负责。

当前 Relay 的支付创建接口会生成新订单号，客户端 SDK 不宣称支付创建具备幂等重试语义。上线前如果
业务需要自动重试，必须先在 Relay 订单表和各支付适配器之间增加持久化幂等键，不能依赖浏览器或
Account Service 进程内状态。

## 配置方式

本项目不提供运行时管理页。所有服务端配置来自环境变量，生产环境统一由 GitHub Actions 的 Environment Variables 和 Secrets 在部署时写入以下文件：

```text
apps/server/.env.actions
```

该文件权限为 `0600`、不会提交到 Git，启动时覆盖 `.env` 中的同名旧值。

### GitHub Actions Secrets

以下值必须放在 Repository Secrets，绝不能放进 Variables、日志或仓库文件：

- `DEPLOY_HOST`
- `DEPLOY_PORT`
- `DEPLOY_USER`
- `DEPLOY_SSH_KEY`
- `DEPLOY_PATH`
- `NEW_API_INTERNAL_TOKEN`（必填，使用 Relay 生成的内部 Token）
- `REDIS_URL`（可选，例如 `redis://:<password>@127.0.0.1:6380/0`）

其中 `DEPLOY_HOST`、`DEPLOY_PORT`、`DEPLOY_USER`、`DEPLOY_PATH`、`DEPLOY_SSH_KEY`
放在 `production` 环境的 Secrets 中；`NEW_API_INTERNAL_TOKEN` 可放在仓库级 Secrets。

### GitHub Actions Environment Variables

生产环境 Variables 至少需要配置：

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
- `CLIENT_DEFAULT_MODEL`（可选，凭证交换响应中的默认模型名）
- `ACCOUNT_SERVICE_PORT`（可选，Docker host network 使用的服务端口，默认 `8787`）

示例：

```text
CORS_ALLOWED_ORIGINS=https://cqai-club.github.io,http://127.0.0.1:3003,http://localhost:3003
LOGTO_CLIENT_PLATFORM_MAP={"web-client-id":{"platform":"lingweave","client_type":"web","redirects":{"https://cqai-club.github.io":{"success_url":"https://cqai-club.github.io/lingweave/billing/result","cancel_url":"https://cqai-club.github.io/lingweave/billing/result?status=cancelled"},"http://127.0.0.1:3003":{"success_url":"http://127.0.0.1:3003/billing/result","cancel_url":"http://127.0.0.1:3003/billing/result?status=cancelled"}}},"desktop-client-id":{"platform":"cqai-desktop","client_type":"desktop","redirects":{"success_url":"cqai://payment/result","cancel_url":"cqai://payment/result?status=cancelled"}}}
```

## Logto 配置

1. 在 Logto 创建 API Resource，例如 `https://account.cqaiclub.asia`。
2. 为该资源创建 `ai:invoke` 权限，并通过角色分配给允许使用 AI 的用户。
3. 每个下游产品使用独立的 Logto SPA Application。
4. 下游应用请求上述 API Resource 的 Access Token。
5. 下游如需将用户资料传入首次 provisioning，授权时同时请求 Logto `profile` 和 `email` 用户 scope。
6. 将每个 Logto Client ID 通过 `LOGTO_CLIENT_PLATFORM_MAP` 映射为固定平台、客户端类型和支付回跳地址。

```env
LOGTO_CLIENT_PLATFORM_MAP={"lingweave-logto-client-id":{"platform":"lingweave","client_type":"web","redirects":{"https://cqai-club.github.io":{"success_url":"https://cqai-club.github.io/lingweave/billing/result","cancel_url":"https://cqai-club.github.io/lingweave/billing/result?status=cancelled"}}},"cqai-desktop-client-id":{"platform":"cqai-desktop","client_type":"desktop","redirects":{"success_url":"cqai://payment/result","cancel_url":"cqai://payment/result?status=cancelled"}}}
```

网页请求使用已通过 CORS 校验的精确 `Origin` 选择回跳地址；桌面客户端使用固定自定义协议，不依赖 `Origin`。未配置的 Client、Origin 或回跳地址会被拒绝。充值请求本身不接受 `success_url`、`cancel_url` 或 `return_url`，避免客户端覆盖服务端策略。

不能接受浏览器传入的任意 `platform`，否则一个应用可能冒充另一个应用并使用其额度。

## 服务端配置

复制 [apps/server/.env.example](apps/server/.env.example) 后配置。生产部署时这些值由 GitHub Actions 写入 `.env.actions`，不要手工编辑服务器上的文件。

| 变量 | 用途 |
|---|---|
| `PORT` | 监听端口，默认 `8787` |
| `DEBUG_AUTH_LOGS` | 临时输出脱敏的认证、账号 provisioning 和下游请求诊断日志，默认 `0` |
| `LOGTO_ISSUER` | Logto Token issuer，通常以 `/oidc` 结尾 |
| `LOGTO_AUDIENCE` | Account Service 对应的 API Resource indicator |
| `LOGTO_JWKS_URI` | JWKS 地址，通常由 issuer 推导 |
| `LOGTO_REQUIRED_SCOPES` | 调用所需 scope，默认 `ai:invoke` |
| `LOGTO_CLIENT_PLATFORM_MAP` | Client ID 到 platform、`client_type` 和支付回跳配置的 JSON 映射；Web 回跳 Origin 必须同时出现在 `CORS_ALLOWED_ORIGINS` |
| `CORS_ALLOWED_ORIGINS` | 允许跨域的浏览器来源 |
| `NEW_API_BASE_URL` | NewAPI 服务端地址（业务接口未配置时返回 503） |
| `NEW_API_INTERNAL_TOKEN` | NewAPI provisioning 内部令牌（不能为空、不能写入变量） |
| `CLIENT_DEFAULT_MODEL` | 可选，受信任客户端凭证交换响应中的默认模型名 |
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

## 容器发布与回滚

推送到 `main` 或手动触发 Actions 时，工作流会先执行 typecheck、测试和构建，再构建
`ghcr.io/cqai-club/cqai-account-service:<commit-sha>` 镜像并推送到 GHCR。服务器不再同步源码或
在服务器编译，而是拉取这个不可变 SHA 镜像，用 Docker 运行并通过 `/healthz` 健康检查。

服务器上的镜像标签约定为：

- `ghcr.io/cqai-club/cqai-account-service:current`：当前运行版本。
- `ghcr.io/cqai-club/cqai-account-service:rollback`：上一个成功版本。

部署成功后只清理其他 Account Service 镜像标签；健康检查失败时自动恢复 `rollback` 标签。
首次部署还没有回滚镜像时，会尝试恢复原有 `cqai-account-service` systemd 服务。

服务器需要预先安装 Docker，并允许部署用户运行 Docker；容器使用 host network，以兼容服务器上
绑定 `127.0.0.1` 的 Redis 和反向代理。部署 job 使用工作流自带的 `GITHUB_TOKEN` 登录 GHCR，
并通过 `packages: read` 拉取镜像；如反向代理不是默认 `8787`，同步设置 `ACCOUNT_SERVICE_PORT`。

部署用户还必须能够非交互地切换旧的 systemd 服务，否则旧进程会继续占用 host network 的服务端口，
新容器会因 `EADDRINUSE` 健康检查失败。以默认用户和服务名为例，服务器可配置最小 sudo 权限：

```sudoers
cqai-deploy ALL=(root) NOPASSWD: /usr/bin/systemctl disable --now cqai-account-service, /usr/bin/systemctl enable --now cqai-account-service
```

如果修改了 `LEGACY_SERVICE_NAME`，sudoers 中的服务名也必须同步修改。workflow 使用 `sudo -n`，
权限缺失时会在启动新容器前直接失败；健康检查失败时会输出容器诊断并清理失败容器，避免留下重启循环。

## 发布前检查

```bash
npm run typecheck
npm test
npm run build
git diff --check
```
