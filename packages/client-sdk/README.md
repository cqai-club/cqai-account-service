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
```

AI 方法返回原始 `Response`，因此普通 JSON 和 SSE 流均可由下游应用按自身方式消费。
