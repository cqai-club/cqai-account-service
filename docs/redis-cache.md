# Account Service Redis 缓存

Account Service 默认使用进程内存缓存。高频调用、多实例或服务重启频繁时，建议启用独立 Redis。

## 推荐部署方式

在同样的服务器上启动独立 Redis 容器，不要复用 Relay 的 Redis：

```bash
docker run -d --restart unless-stopped \
  --name cqai-account-redis \
  -p 127.0.0.1:6380:6379 \
  -v cqai-account-redis-data:/data \
  --requirepass "$(openssl rand -base64 32)" \
  redis:7-alpine redis-server --appendonly yes
```

`127.0.0.1:6380` 只允许本机访问。`REDIS_URL` 应放入 GitHub Actions Secret，例如：

```text
redis://:<password>@127.0.0.1:6380/0
```

不要使用无密码的 `redis://127.0.0.1:6380` 作为生产配置，也不要将 Redis 端口暴露到公网。

## 缓存内容与安全

缓存键是 `issuer + subject + platform` 的 SHA-256。缓存值包含用户 ID、平台、Token ID、配额和 NewAPI Key，写入 Redis 前使用 AES-256-GCM 加密；加密密钥从 `NEW_API_INTERNAL_TOKEN` 派生。Redis 中不会出现 Key 明文。Redis 临时故障时自动回退到内存，不阻塞业务请求。

## 备份与清理

- 使用 `appendonly yes` 确保持久化；备份 Redis 数据卷按 Redis 官方流程执行。
- 若管理员删除了 NewAPI Token，缓存会在 TTL 过期后被刷新；必要时可删除 `cqai:account-cache:v1:*` 前缀的键。
- 不要让多个部署共享同一个 Redis 数据卷或数据库，避免不同服务的 key 互相污染。
