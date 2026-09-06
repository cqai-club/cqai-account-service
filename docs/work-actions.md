# 待办工作清单（账号桥接改造）

> 目的：把当前分散在脑子和对话里的改造点固化成文档，后续按顺序执行，避免遗漏。

---

## 一、总体目标

1. **所有登录统一走 Logto**：关闭/移除 Relay（NewAPI）原生登录（含原生 OIDC），登录、注册、权限全部由 Logto + Account Service 桥接承担。
2. **账号懒创建**：用户只在 Logto 注册/登录时，NewAPI 不立即建号；首次调用 `/api/account` 或 `/v1/*` 才创建 NewAPI 用户、身份绑定、应用专属 API Key。
3. **权限用 scope 而不是 role map**：不再使用 `LOGTO_ROLE_MAP`，改为 `LOGTO_ADMIN_SCOPE` / `LOGTO_ROOT_SCOPE`，由管理员在 Logto 中配置角色并赋权。
4. **配置全部改到 GitHub Actions**：删除 admin 页面（已完成），配置写入 Repository Variables/Secrets，服务启动时写 `.env.actions`（已实现，需验证）。
5. **Redis 缓存保留**：已接入 `REDIS_URL`（可选），缓存值 AES-256-GCM 加密，Redis 故障回退内存缓存。
6. **新用户初始额度 0 仅是提示**：不强制改默认值，交给部署侧 `QuotaForNewUser`，服务端只在额度不足时给出明确提示。

---

## 二、当前状态

### 已完成（已提交）
- admin 页面整套删除（`apps/admin/*`、`apps/server/src/admin-assets.ts`、`apps/server/src/runtime-config.ts` 及其测试、`docs/admin-config-auth.md`）。
- 服务端改为纯环境变量 + 只读配置；运行时不再提供 `/api/admin/*`、`/admin` 页面、`CONFIG_STORE_PATH`。
- Redis 缓存实现（`apps/server/src/cache.ts`）：内存缓存兜底 + Redis 加密缓存。
- GitHub Actions 部署流已把配置写入 `apps/server/.env.actions`（0600 权限），并校验单行值。
- 生成额度提示：`/api/account` 返回 `quota`/`quotaUsed`，前端可提示"额度不足"（服务端无需改默认值）。

### 未提交（工作区有改动，需审查后提交）
- `apps/server/src/config.ts`：去掉 `LOGTO_ROLE_CLAIM` / `LOGTO_ROLE_MAP`，新增 `LOGTO_ADMIN_SCOPE` / `LOGTO_ROOT_SCOPE`（默认 `account:admin` / `account:root`）。
- `apps/server/src/logto.ts`：按 scope 解析角色——`root scope → 100`，`admin scope → 10`，无则普通用户；不再读 `roles` claim。
- `.env.example`、`deploy.yml`、相关测试同步更新。
- 注意：`LOGTO_ADMIN_SCOPE` / `LOGTO_ROOT_SCOPE` 是新变量名，GitHub 仓库 Variable 里也需要对应新增/改名。

---

## 三、按优先级待办

### P0 统一入口（relay 侧）
- [ ] 确认 production 是否还有实例开着 Relay 原生 OIDC / 原生登录入口。
- [ ] 封住 Relay 原生登录入口：
  - 后端不再接受 OIDC 注册/绑定/登录：`oauth/oidc.go`、`controller/oauth.go`、`router/api-router.go` 的 `/oauth/oidc` 处理改为禁用/下线（保守做法：`IsEnabled=false` + 返回 403/404）。
  - 前端不再展示 OIDC 登录按钮：`web/src/features/auth/components/oauth-providers.tsx`、`web/src/features/auth/hooks/use-oauth-login.ts`、`web/src/features/auth/lib/oauth.ts`。
- [ ] 受保护页面：未登录时跳过 `/sign-in` 页面，直接跳转 Logto 授权页（Account Service 发起的 Authorization Code + PKCE）。
  - 备选：先走 `/sign-in` 但登录按钮直接指向 Logto；与用户确认是否要"页面直接跳转、不弹 sign-in"（用户倾向直接跳转）。
- [ ] 验证首次访问受保护页面时能看到 Logto 登录页、回跳后注册/登录成功、首次 `/api/account` 自动建号。

### P1 配置持久化（GitHub Actions）
- [ ] 确认仓库变量里已存在（用户在截图中已确认部分已有）：
  - `LOGTO_ISSUER`、`LOGTO_AUDIENCE`、`CORS_ALLOWED_ORIGINS`、`LOGTO_CLIENT_PLATFORM_MAP`
- [ ] 新增/改名变量：
  - `LOGTO_ADMIN_SCOPE`（默认 `account:admin`）
  - `LOGTO_ROOT_SCOPE`（默认 `account:root`）
- [ ] 确认 Secrets 已有：`DEPLOY_HOST`、`DEPLOY_PORT`、`DEPLOY_USER`、`DEPLOY_PATH`、`DEPLOY_SSH_KEY`、`NEW_API_INTERNAL_TOKEN`、`REDIS_URL`（可选）。
- [ ] 重新部署后检查：启动日志无 `CONFIG_INVALID`，`/status` 或环境变量生效。

### P2 Redis 确认
- [ ] 若业务高频调用，建议启用独立 Redis（回环地址 `127.0.0.1:6380`，带密码），`REDIS_URL` 放 Secret。
- [ ] 验证：Redis 宕机时服务不崩溃、自动回退内存缓存；恢复后重新写入。
- [ ] 验证：Redis 中无明文 API Key（AES-GCM 加密）。

### P3 角色/权限模型验证
- [ ] 在 Logto 确认是否已建立：API Resource（`https://account.cqaiclub.asia`）、`ai:invoke` 权限、角色（`admin`/`root`）、用户-角色绑定。
- [ ] 把"root 管理超级管理员"迁移进 Logto：`root` 用户/角色在 Logto 中以 `LOGTO_ROOT_SCOPE` 标识，Account Service 映射为 NewAPI `role=100`。
- [ ] 验证：带 root scope 的 token 建号后是超级管理员；带 admin scope 是管理员；没有 scope 是普通用户。

### P4 多账号/多应用映射
- [ ] 核对下列映射行为（需求已写明，代码层大多已实现，需测试覆盖）：
  - `issuer + sub` 相同 → 复用用户；platform 不同 → 复用用户 + 新建应用 Key。
  - 两个 Client ID 映射同一 platform → 复用同一把 Key。
  - 同人两个 Logto 账号（sub 不同）→ 两个 NewAPI 用户。
  - 邮箱相同不合并。
  - 并发首次访问 → 唯一约束保证复用同一用户和 Key。
  - 无邮箱时 bridge 允许、不影响建号（原生 OIDC 强制邮箱的差异已随 OIDC 关闭消除）。
  - 应用 Key 被删：当前不自动重建，直接报错（需求接受，仅需归档说明）。
- [ ] 缺：并发首次访问的数据库唯一约束测试（若 relay 侧没有，补一条）。

### P5 用户体验 / 提示
- [ ] 新用户默认额度 0 时，前端给出明确提示（额度不足/联系管理员），不另设服务端默认值。
- [ ] 中文文案核对（登录按钮、OIDC 名称、错误提示）。

---

## 四、分仓库改动清单

### `cqai-account-service`（本仓库）
| 文件 | 改动 |
|---|---|
| `apps/server/src/config.ts` | scope 解析，删 role map，新增 admin/root scope |
| `apps/server/src/logto.ts` | 按 scope 映射角色 |
| `apps/server/src/accounts.ts` | 透传 `role` 到 provision（已存在，确认） |
| `apps/server/test/*` | 同步测试并全绿 |
| `.github/workflows/deploy.yml` | 变量名同步 |
| `apps/server/.env.example` | 文档同步 |
| `README.md` | 更新配置说明（已完成） |

> 当前工作区已有上述改动，执行前先 `git diff` 审查 → `npm run typecheck` → `npm test` → `npm run build`。

### `cqai-relay`（NewAPI）
| 文件 | 改动 |
|---|---|
| `oauth/oidc.go` | 停用原生 OIDC（注册入口也走 Account Service） |
| `controller/oauth.go` | `/oauth/oidc` 回调处理改为禁用/403 |
| `router/api-router.go` | 不再暴露原生 OIDC 路由 |
| `web/src/features/auth/components/oauth-providers.tsx` | 移除 OIDC 登录按钮 |
| `web/src/features/auth/hooks/use-oauth-login.ts` | 移除 OIDC 处理 |
| `web/src/features/auth/lib/oauth.ts` | 不再构建 OIDC URL |
| `web/src/routes/_authenticated/route.tsx` | 未登录直接跳 Logto（已有改动，确认/完善） |
| 配置/设置 | 关闭 OIDC enabled；或删除 OIDC 配置项 |

---

## 五、发布前检查
```bash
cd cqai-account-service && npm run typecheck && npm test && npm run build && git diff --check
cd ../cqai-relay && go test ./... # 或 make test
```

## 六、需要用户确认的决策
1. 受保护页面登录：直接跳 Logto（不弹 sign-in 页）能否接受？备用登录方式（GitHub/Discord/Telegram 等）是否全部都改为指向 Logto / Account Service？
2. `LOGTO_ADMIN_SCOPE` / `LOGTO_ROOT_SCOPE` 的确切 scope 字符串是否就是 `account:admin` / `account:root`？
3. Relay 原生 OIDC 是直接删除还是仅禁用（保留以后复用）？
4. 是不是所有 n8n/其他 AI 应用都只对接 Account Service 的 `/api/account` 和 `/v1/*`（不碰 relay）？
