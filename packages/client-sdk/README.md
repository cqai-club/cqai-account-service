# @cqaiclub/account-client

面向 CQAI 下游浏览器应用的 Account Service 客户端。它只携带调用方提供的 Logto Access Token，不包含 Logto Secret、NewAPI Service Token 或 NewAPI API Key。

```ts
import { CqaiAccountClient } from '@cqaiclub/account-client'

const client = new CqaiAccountClient({
  baseUrl: 'https://account.cqaiclub.asia',
  getAccessToken: () => getAccessToken('https://account.cqaiclub.asia'),
})

const account = await client.getAccount()
const response = await client.createChatCompletion({
  model: 'gpt-5',
  messages: [{ role: 'user', content: '你好' }],
  stream: true,
})

const payment = await client.createTopUp({
  payment_option_id: 'card',
  amount: 100,
})

const recentPayments = await client.listTopUps({ page: 1, pageSize: 10 })
```

调用方先读取 `getTopUpInfo()` 获得 Account Service 归一化的 `payment_options`，再把选项 ID 传给 `createTopUp()`；调用方不需要知道 provider、Relay 路由或回跳地址。Account Service 根据 Logto access token 中的 `client_id` 和浏览器 `Origin`（桌面客户端使用固定自定义协议）选择服务端配置的回跳地址。Relay 会追加命名空间查询参数 `cqai_order_id`，回跳后应通过 `listTopUps` 或账号摘要确认最终入账状态。

AI 方法返回原始 `Response`，因此普通 JSON 和 SSE 流均可由下游应用按自身方式消费。
