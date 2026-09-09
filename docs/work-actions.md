# 待办工作清单（账号桥接改造）

> 目的：把当前分散在脑子和对话里的改造点固化成文档，后续按顺序执行，避免遗漏。

---

## 一、总体目标

1. **业务 AI 统一走 Logto + Account Service**：业务应用登录后，将 Logto API Access Token 交给 Account Service，由它桥接 Relay 的账号、Token 和 AI 接口。Relay 原生登录/OIDC 可以继续保留，作为 Relay 管理后台或兼容入口，不纳入本次业务桥接改造。
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
- `LOGTO_ADMIN_SCOPE` / `LOGTO_ROOT_SCOPE` 与按 scope 解析 role 已提交，不再依赖 `LOGTO_ROLE_CLAIM` / `LOGTO_ROLE_MAP`。
- Account Service 已从已验证 Access Token 中读取 email、username/preferred_username 和 name，并通过 Account SDK 透传给 Relay 首次 provisioning。
- Relay 已支持 OIDC 用户与 `ExternalAccountIdentity` 双向复用同一本地用户，并覆盖并发首次请求。

---

## 三、按优先级待办

### P0 统一业务 AI 入口
- [ ] 确认每个业务应用都使用 Logto API Resource Access Token，并请求 `ai:invoke`。
- [ ] 确认业务应用只调用 Account Service 的 `/api/account`、`/v1/*`，不直接持有 Relay Service Token 或完整 API Key。
- [ ] 验证首次访问 `/api/account` 或 `/v1/*` 时自动完成 Relay provisioning。
- [x] Relay 原生 OIDC 仅作为管理后台/兼容入口保留，不在本次改造中删除或下线。

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
- [ ] 核对下列映射行为（核心幂等、跨 platform、OIDC 用户复用和并发首次请求已有 Relay 测试，其余需继续补齐）：
  - `issuer + sub` 相同 → 复用用户；platform 不同 → 复用用户 + 新建应用 Key。
  - 两个 Client ID 映射同一 platform → 复用同一把 Key。
  - 同人两个 Logto 账号（sub 不同）→ 两个 NewAPI 用户。
  - 邮箱相同不合并。
  - 并发首次访问 → 唯一约束保证复用同一用户和 Key。
  - 无邮箱时 bridge 和 Relay 原生 OIDC 都允许建号；OIDC 优先使用已验证 ID Token 资料。
  - 应用 Key 被删：当前不自动重建，直接报错（需求接受，仅需归档说明）。
- [x] Relay 已有并发首次访问的数据库唯一约束/回读测试，会校验只生成一个用户、Token、Identity 和 AppCredential。

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
| `apps/server/src/accounts.ts` | 透传已验证的 email、username、name 和 `role` 到 provision |
| `apps/server/test/*` | 同步测试并全绿 |
| `.github/workflows/deploy.yml` | 变量名同步 |
| `apps/server/.env.example` | 文档同步 |
| `README.md` | 更新配置说明（已完成） |

> 上述 Account Service 改动已提交。继续改造时仍需先 `git diff` 审查 → `npm run typecheck` → `npm test` → `npm run build`。

### `cqai-relay`（NewAPI）
| 文件 | 改动 |
|---|---|
| `controller/account_provision.go` / `service/account_provision.go` | 提供受内部 Token 保护的幂等 provisioning |
| `model/account_provision.go` | 维护 `(issuer, subject)` 身份和 `(user, platform)` 应用凭证，并与 `users.oidc_id` 复用同一用户 |
| Relay 原生 OIDC | 保留为管理后台/兼容入口，不承担业务应用的统一桥接职责 |

---

## 五、发布前检查
```bash
cd cqai-account-service && npm run typecheck && npm test && npm run build && git diff --check
cd ../cqai-relay && go test ./... # 或 make test
```

## 六、已确定与待确认的决策

- 已确定：业务 AI 统一通过 Account Service；Relay 原生 OIDC 保留为管理后台/兼容入口，本次不删除、不下线。
- 待部署核对：`LOGTO_ADMIN_SCOPE` / `LOGTO_ROOT_SCOPE` 是否在 Logto 和生产环境中均已配置为 `account:admin` / `account:root`。
- 待产品确认：n8n 和后续其他 AI 应用是否全部只对接 Account Service 的 `/api/account` 和 `/v1/*`。
- 待安全决策：Account Service provisioning 是否要对已有用户同步角色；当前仅首次建号使用 role。
