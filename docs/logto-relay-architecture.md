# Logto -> Account Service -> cqai-relay 架构记录

> 工作副本校验日期：2026-09-07
>
> 本文是 Account Service 侧的快速索引。Relay 侧的完整架构、当前状态和验收清单见 `cqai-relay/docs/logto-account-service-architecture.md`。

## 定位

`cqai-account-service` 是 Logto 与 NewAPI/Relay 之间的服务端账号桥接和 AI BFF：

```text
浏览器/下游产品
  -> Logto Access Token
  -> Account Service
  -> Relay /api/internal/provision
  -> Relay NewAPI Key
  -> Relay /v1/*
```

浏览器不得接触 NewAPI Service Token 或完整 NewAPI Key。

## 已实现的职责

- 用 JWKS 校验 Logto JWT 签名、issuer、audience 和过期时间。
- 校验必要 scope，默认是 `ai:invoke`。
- 用 `client_id -> platform` 白名单确定应用平台，不信任前端传入的 platform。
- 从已验证 Access Token 中读取 email、username/preferred_username 和 name，用于首次 Relay 建号，不额外调用 UserInfo。
- 使用 `(issuer, subject, platform)` 解析/缓存账号。
- 通过幂等的 `POST /api/internal/provision` 获取 Relay 应用凭证。
- 对外提供 `GET /api/account` 和 `/v1/*`。
- 对受信任客户端提供 `GET /api/client-credential`：在 Logto Access Token 验证通过后返回 Relay 地址、用户平台 API Key 和可选默认模型；带 `Origin` 的浏览器请求一律拒绝。
- 响应中移除 Cookie、CORS 和逐跳敏感头，NewAPI Key 只留在服务端转发链路。

## 与 Relay 当前登录链路的边界

Relay 当前的 `/oauth/oidc` 是另一条传统 Web 登录链路：它自己换 Token，优先通过 discovery/JWKS 验证 ID Token（缺少时才回退 UserInfo），写入 `users.oidc_id` 并创建 Relay Session。Account Service 不会自动接管这条登录链路。

因此，当前版本可以确认：

- Account Service 自身的 Logto/JWT/provisioning 桥接能力已具备。
- Relay 的直接 OIDC 登录能力已具备。
- Relay provisioning 在建立外部身份前会按 `users.oidc_id == subject` 复用原生 OIDC 用户；由 Account Service 先建号时也会写入同一 `oidc_id`，因此当前单一 Logto issuer 下两种先后顺序都会复用同一 Relay 用户。

## 必须保持一致的配置

| 配置 | 要求 |
|---|---|
| `LOGTO_ISSUER` | 与 Logto issuer 完全一致 |
| `LOGTO_AUDIENCE` | 与授权请求中的 `resource` 完全一致 |
| `LOGTO_REQUIRED_SCOPES` | 至少包含 `ai:invoke` |
| `LOGTO_CLIENT_PLATFORM_MAP` | 包含实际下游 Client ID，并固定 platform |
| `LOGTO_ADMIN_SCOPE` | 默认 `account:admin` |
| `LOGTO_ROOT_SCOPE` | 默认 `account:root` |
| `NEW_API_BASE_URL` | 指向 Relay 服务 |
| `CLIENT_DEFAULT_MODEL` | 可选，`/api/client-credential` 返回的默认模型名 |
| `NEW_API_INTERNAL_TOKEN` | 与 Relay provisioning token 一致，仅存服务端 Secret |
| `CORS_ALLOWED_ORIGINS` | 只允许明确的前端来源 |

## 当前未闭环事项

1. `external_account_identities` 用 `(issuer, subject)` 建键，但 Relay 原生 `users.oidc_id` 只保存 `subject`；当前收敛适用于单一 Logto issuer，接入多 issuer 前需扩展原生 OIDC 绑定模型。
2. Relay 管理面 OIDC 已在登录时同步已有用户角色，Account Service provisioning 对已有用户则不重新设角色，两条链路的角色更新语义仍不一致。
3. 已明确 Relay OIDC 保留为管理后台/兼容入口，业务 AI 请求统一经过 Account Service；仍需用真实公网部署完成端到端验收。

## 验收重点

- 同一个 `(issuer, subject)` 在不同 platform 下复用同一个 Relay 用户。
- 同一用户的不同 platform 只拥有不同 `app_credentials`，不重复建用户。
- 首次请求、并发请求和缓存失效都返回同一个应用凭证。
- `/api/account` 不泄露 API Key，`/v1/*` 只在服务端替换为 Relay Key。
- 使用真实 Logto Access Token 完成 Account Service -> Relay -> AI 的端到端验证。
