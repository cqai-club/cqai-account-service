# Account Service 支付 BFF 设计

## 目标

让使用 Logto 登录的业务应用可以通过 Account Service 使用 Relay/NewAPI 已有的充值和订阅支付能力，不要求浏览器登录 NewAPI，也不向浏览器返回 NewAPI API Key、Service Token 或 Session Cookie。

## 边界

```text
浏览器
  -- Logto Access Token --> Account Service /api/billing/*
                              -- NEW_API_INTERNAL_TOKEN --> Relay /api/internal/payment/*
                                                               --> NewAPI 支付适配器
支付平台 webhook ---------------------------------------------> Relay
                                                               --> NewAPI TopUp/SubscriptionOrder + 钱包额度
```

- Account Service 负责 Logto JWT、平台映射、用户 provisioning、公开支付门面和响应过滤。
- Relay/NewAPI 负责价格和支付配置、支付渠道 SDK、订单持久化、webhook 验签、重复回调幂等、钱包/订阅入账。
- 调用方只提交 Account Service 返回的支付选项 ID、金额档位或套餐 ID；具体 provider、`user_id`、实际价格、回跳地址和入账额度由服务端决定。
- Account Service 根据已验证 Logto Token 的 `client_id` 查找客户端配置：Web 按精确 `Origin` 选择回跳地址，桌面按客户端类型使用固定自定义协议。未配置的 Client、Origin 或回跳地址直接拒绝。
- 回跳地址只用于支付平台完成后的客户端导航，不代表支付成功；Account Service 把固定回跳地址注入 Relay，Relay 仅对 Account Service 内部请求做 URL 危险协议/凭据检查，并追加命名空间参数 `cqai_order_id`。Relay 原生管理后台/兼容入口仍使用自己的 `TRUSTED_*` 白名单。
- 浏览器跳转回支付页面不代表支付成功，前端应重新查询充值记录或账号余额；最终状态以 Relay webhook 入账为准。

## 内部合同

所有内部支付接口复用 `NEW_API_INTERNAL_TOKEN`，并接受服务端生成的 envelope：

```json
{
  "user_id": 123,
  "payload": {
    "amount": 100,
    "payment_method": "alipay"
  }
}
```

`user_id` 只由已通过 Logto 鉴权并完成 provisioning 的 Account Service 传入，不能从公开请求透传。Relay 内部路由只允许固定的支付 provider，不允许任意路径代理。

## 公开接口

- `GET /api/billing/topup/info`
- `GET /api/billing/topups`
- `POST /api/billing/topups`（使用 `payment_option_id`，回跳由 Account Service 根据客户端配置决定）
- `GET /api/billing/subscription/plans`
- `GET /api/billing/subscription/self`
- `POST /api/billing/subscription/:provider`

公开接口全部使用 Logto Bearer Token。Account Service 将 Relay 的 provider 配置归一化为 `payment_options`，并在创建充值订单时完成支付选项到 provider 的内部映射。支付创建响应只返回支付平台需要的跳转 URL、表单参数、订单号或会话信息；Account Service 过滤 Cookie、CORS 和逐跳响应头。调用方不需要知道 Relay 地址或 provider 路由。

充值创建请求示例：

```json
{
  "payment_option_id": "card",
  "amount": 100
}
```

## 重试和订单状态

当前 Relay 的原生支付控制器负责生成订单号并在 webhook 中以数据库订单状态完成入账。Account Service 不缓存支付创建响应，也不自行修改额度。后续如果业务需要客户端重试语义，应在 Relay 的支付订单表中增加持久化幂等键，并让 provider 创建和本地订单建立共享幂等约束；不能用 Account Service 进程内内存代替订单幂等。

## 验收条件

1. 无 Logto Token、错误来源或错误 scope 不能创建支付订单。
2. Account Service 发给 Relay 的请求只有内部 Token、已解析的 NewAPI `user_id` 和白名单 payload。
3. Relay 内部支付接口没有有效内部 Token 时返回 401；未知 provider 返回 404。
4. 浏览器响应不包含 `api_key`、`NEW_API_INTERNAL_TOKEN`、Cookie 或 NewAPI Session。
5. 支付渠道未配置、金额/套餐无效、支付取消等情况不会增加钱包额度。
6. webhook 仍由 Relay 接收、验签并完成订单状态转换和额度入账。
