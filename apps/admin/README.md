# CQAI 管理控制台

这是一个不依赖前端框架或第三方运行时的静态管理页。页面只显示一个 Logto 登录入口，并使用登录后获得的 Access Token 调用 Account Service 配置管理 API。Token 具备对应的 `config:read` / `config:write` 权限即可访问相应功能。

- `corsAllowedOrigins`
- `logtoRequiredScopes`
- `logtoClientPlatforms`
- `accountCacheTtlSeconds`
- `maxRequestBodyBytes`

页面会显示并允许修改 `NEW_API_BASE_URL`。`NEW_API_INTERNAL_TOKEN` 不在页面中读取或提交，必须由服务端环境或 Secret Manager 提供。Logto Token 仅放在当前浏览器 `sessionStorage`，退出时删除；所有请求都使用 `credentials: omit` 和 `Authorization: Bearer ...`。

## 构建和本地预览

在仓库根目录执行：

```bash
npm run build --workspace=@cqaiclub/account-admin
python3 -m http.server 4174 -d apps/admin/dist
```

也可以使用 `npm run dev --workspace=@cqaiclub/account-admin`，它会先构建产物再启动静态服务器。

然后打开 <http://localhost:4174/>。也可以执行 `npm run typecheck --workspace=@cqaiclub/account-admin` 做前端类型检查。

执行仓库根目录的 `npm run build` 后，Account Service 默认会把同一份产物挂在 `/admin/`（例如 `http://localhost:8787/admin/`）；如果只构建服务端而未构建管理页，`/admin/` 会返回明确的构建提示。

静态部署时将 `apps/admin/dist` 作为站点根目录。若挂载到 Account Service 的 `/admin/` 路径，让静态服务器将 `/admin/` 指向该目录即可；构建产物中的 `index.html`、`main.js`、`oidc.js`、`styles.css` 位于同一目录。

## 服务端接口约定

页面默认请求当前站点同源的 Account Service；登录参数由服务端的 `/admin/oidc-config` 自动提供，不在页面中手工填写。服务端应提供：

如果页面和 Account Service 同源，服务端可以只配置 Logto 基础地址、管理员 Client 和 NewAPI 连接信息，`CORS_ALLOWED_ORIGINS` 与 `LOGTO_CLIENT_PLATFORM_MAP` 留空即可。管理页首次登录后再填写这两项；留空期间跨域请求和未映射的客户 Client 都会被拒绝。

```http
GET /api/admin/config
Authorization: Bearer <Logto 管理员 Access Token>
```

```json
{
  "success": true,
  "data": {
    "version": 3,
    "updatedAt": "2026-09-03T08:00:00.000Z",
    "status": "active",
    "corsAllowedOrigins": ["https://app.example.com"],
    "logtoRequiredScopes": ["config:read", "config:write"],
    "logtoClientPlatforms": {"example-client-id": "example"},
    "accountCacheTtlSeconds": 300,
    "maxRequestBodyBytes": 20971520
  }
}
```

保存时页面发送 `PUT /api/admin/config`，请求体为上述可编辑字段，并附带当前 `version` 作为乐观锁版本。服务端应在校验失败时返回 `4xx`，版本冲突建议返回 `409 CONFIG_VERSION_CONFLICT`。`POST /api/admin/config/validate` 是可选的“只验证不保存”接口；不存在时页面会提示可直接保存。

页面通过不需要 Token 的 `GET /admin/oidc-config` 获取 `issuer`、`clientId`、`audience` 和 `redirectUri`，再自动发起 OIDC Authorization Code + PKCE 登录；SPA 不需要客户端密钥。

## 接入 `/admin`

推荐由 Account Service 同源提供 `/admin/`。`/api/admin/*` 仍由服务端校验 Logto 签名、issuer、audience、有效期、客户端声明和 `config:*` scope；静态页面本身不是安全边界。
