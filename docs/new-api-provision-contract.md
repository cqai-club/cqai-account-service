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
  "name": "Optional display name"
}
```

服务端必须：

1. 使用常量时间比较验证内部 Token。
2. 以 `(issuer, subject)` 唯一确定外部用户身份。
3. 以 `(user_id, platform)` 唯一确定应用凭证。
4. 在同一事务中创建或复用 NewAPI 用户、身份绑定和 Token。
5. 正确处理并发首次请求，不能创建重复用户或重复 Token。
6. 对同一幂等键和同一身份返回相同绑定。
7. 禁止客户端通过该接口指定管理员角色、任意用户组或无限额度。
8. 不记录 Authorization、完整 API Key 或请求中的身份敏感信息。

## 成功响应

字段支持 snake_case；现有 `cqai-account-sdk` 会归一化字段名。

```json
{
  "success": true,
  "data": {
    "user_id": 123,
    "token_id": 456,
    "api_key": "sk-server-only-value",
    "platform": "lingweave",
    "user_created": false,
    "key_created": false,
    "quota": 100000,
    "quota_used": 1200
  }
}
```

`api_key` 只返回给经过内部 Token 验证的 Account Service。Account Service 不会把它放进 `/api/account` 响应。

## 建议数据约束

```text
external_identities: UNIQUE(issuer, subject)
app_credentials:     UNIQUE(user_id, platform)
idempotency_records: UNIQUE(idempotency_key)
```

如果希望保持 Account Service 无状态，NewAPI 每次 provisioning 都应能够安全返回当前完整 Key；如果不允许重复返回完整 Key，则需要由 Account Service 使用加密存储持久化 Key。
