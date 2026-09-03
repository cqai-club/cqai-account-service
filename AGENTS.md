# AGENTS.md

## 基本原则

- 本项目是 Logto 与 NewAPI 之间的服务端账号桥接和 AI BFF。
- 浏览器只提交 Logto Access Token；不得向浏览器返回 NewAPI Service Token 或完整 API Key。
- 服务端必须校验 JWT 的签名、issuer、audience、有效期、客户端和必要 scope。
- NewAPI Key 只能存在于服务端内存和到 NewAPI 的请求头中，不得写入日志、错误响应或持久化明文文件。
- 跨域使用明确来源白名单，不启用通配来源与凭证 Cookie 的组合。
- 下游 SDK 不包含任何服务端密钥，也不自行解析或信任 JWT。
- 修改后至少执行 `npm run typecheck`、`npm test`、`npm run build` 和 `git diff --check`。

## 项目结构

- `apps/server/`：可独立部署的 Account/BFF 服务。
- `packages/client-sdk/`：提供给浏览器应用使用的无密钥客户端 SDK。
- NewAPI 服务端访问统一通过 `@cqaiclub/cqai-account-sdk`。

## 实现约束

- 优先保持无状态；账号和 Key 映射由 NewAPI provisioning 接口负责。
- `platform` 必须根据已验证 Token 的客户端 ID 映射，不接受前端任意指定。
- AI 代理仅允许固定的 `/v1` 路径，不接受完整上游 URL。
- 转发请求时移除浏览器的 Authorization、Cookie、Host 和逐跳请求头，再写入服务端 NewAPI Key。
- 转发响应时移除 Set-Cookie、CORS 和逐跳响应头，保留流式响应体。
