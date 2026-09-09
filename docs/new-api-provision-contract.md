# NewAPI Provisioning 接口合同

Account Service 依赖 NewAPI 提供一个仅限服务端访问的幂等接口。

## 请求

```http
POST /api/internal/provision
Authorization: Bearer <NEW_API_INTERNAL_TOKEN>
Idempotency-Key: account-<sha256>
Content-Type: application/json
```

```json
{
  "issuer": "https://auth.cqaiclub.asia/oidc",
  "subject": "logto-user-id",
  "platform": "lingweave",
  "email": "optional@example.com",
  "username": "optional-logto-username",
  "name": "Optional display name",
  "role": 1,
  "sync_profile": false
}
```

`email`、`username`、`name`、`role` 和 `sync_profile` 均为可选字段。Account Service 当前从已验证的 Logto Access Token 透传 email、username/name 和可信 role，不会把前端任意传入的资料或角色直接发给 Relay。

服务端必须：

1. 使用常量时间比较验证内部 Token。
2. 以 `(issuer, subject)` 唯一确定外部用户身份。
3. 以 `(user_id, platform)` 唯一确定应用凭证。
4. 在同一事务中创建或复用 NewAPI 用户、身份绑定和 Token。
5. 正确处理并发首次请求，不能创建重复用户或重复 Token。
6. 当已存在 `users.oidc_id == subject` 的 Relay OIDC 用户时复用该用户；由 provisioning 新建用户时将 subject 写入 `users.oidc_id`。
7. 对同一幂等键和同一身份返回相同绑定。
8. `role` 只接受 `1` / `10` / `100`，并且只在首次创建用户时生效；不允许通过该接口更改已有用户角色、用户组或创建无限额度 Token。
9. `sync_profile=true` 只允许同步不冲突的 username 和 display name，不同步 role、group、quota 或凭证。
10. 不记录 Authorization、完整 API Key 或请求中的身份敏感信息。

## 成功响应

字段支持 snake_case；现有 `cqai-account-sdk` 会归一化字段名。

```json
{
  "success": true,
  "data": {
    "user_id": 123,
    "token_id": 456,
    "credential_id": 789,
    "api_key": "sk-server-only-value",
    "platform": "lingweave",
    "user_created": false,
    "credential_created": false,
    "key_created": false,
    "user_status": 1,
    "token_status": 1,
    "quota": 100000,
    "quota_used": 1200
  }
}
```

`api_key` 只返回给经过内部 Token 验证的 Account Service。Account Service 不会把它放进 `/api/account` 响应。

## 建议数据约束

```text
external_account_identities.identity_key: UNIQUE(sha256(issuer + "\\0" + subject))
app_credentials:                          UNIQUE(user_id, platform)
```

当前 Relay 为了跨 SQLite/MySQL/PostgreSQL 使用可控长度索引，实际以 `sha256(issuer + "\\0" + subject)` 作为 `external_account_identities.identity_key` 唯一键，并同时保存 issuer 和 subject 用于碰撞校验。并发冲突由数据库唯一索引与失败后回读处理，不依赖独立幂等记录表。

如果希望保持 Account Service 无状态，NewAPI 每次 provisioning 都应能够安全返回当前完整 Key；如果不允许重复返回完整 Key，则需要由 Account Service 使用加密存储持久化 Key。
