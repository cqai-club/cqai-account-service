# e剪宝：平台充值、积分与托管生成

用户登录 CQAI 账户后向平台充值，资金通过平台配置的支付商户结算给运营方。平台账户获得积分，e剪宝调用平台接口并消费同一本账本；InferFlow 是平台的上游供应商，普通用户不填写厂商 Key。

## 现有管理入口

中转站：<https://relay.cqaiclub.asia>，使用平台管理员账户登录。进入「系统设置 / Billing & Payment」：

| 设置 | 用途 |
| --- | --- |
| Currency & Display | 额度显示选 CUSTOM，名称填“积分”；custom_currency_exchange_rate 表示一个账本计价单位显示多少积分。 |
| Payment Gateway | 填运营方的收款商户、支付密钥、回调地址；设置充值基础价格。 |
| Model Pricing | 配置 ejianbao-digitalhuman 按秒计费表达式。 |
| Group Pricing | 配置用户组消费倍率和充值折扣。 |

充值由现有支付服务下单和验签入账，不能用浏览器支付成功跳转作为入账凭证。商户配置必须由运营方确认；代码接通不能证明资金已经进入运营方商户。

### 1 元兑换 K 积分

保持现有账本单位不变。设自定义显示倍率为 E，易支付基础价格 Price 为 P；充值和用户组折扣均为 1 时，1 元兑换 E/P 积分。因此要设置 1 元=K 积分，设置 Price=E/K。不要为调整新充值价格而修改旧账本的 QuotaPerUnit；调整 E 会同时改变历史余额的积分显示。

2026-09-15 检查到线上公开配置：E=10、P=1、quota_per_unit=500000、显示为“积分”。这是基础比例 1 元=10 积分，实际支付仍取决于渠道、套餐与折扣。Stripe、Creem、Waffo 有各自价格配置，不能把易支付的 P 自动套用到其他渠道。

若数字人售价为 S 积分/秒，用户组倍率为 1：

- Relay 任务表达式：`u("seconds") * (S / E)`，部署时把括号换成计算后的十进制数。
- Account Service：`EJIANBAO_QUOTA_PER_SECOND = S * quota_per_unit / E`，要求正整数。
- 最低计费 10 秒，超过 10 秒按实际视频时长向上取整。
- 两处价格需要同步修改。报价为预估，最终以 Relay 消费记录为准；分组倍率也影响最终费用。

此实现没有预设商业售价，也没有修改线上充值比例。

## 服务端部署

1. 在 Relay 任务插件管理上传 integrations/relay/ejianbao.plugin.js。先测试再启用，不覆盖同名未知插件。
2. 新建 type-59 Task Plugin 渠道，绑定插件 ejianbao、模型 ejianbao-digitalhuman；Base URL 为 https://saas.inferflow.dev/openapi/v1，Key 是运营方的 InferFlow 平台 Key。
3. 在 Model Pricing 为该模型启用 tiered_expr 任务计费，填上面的按秒表达式。不要配置成普通文本 token 计费或固定按次计费。插件 seconds 为预估时长和实际完成时长。
4. 在 Account Service GitHub Actions Secrets 配置 INFERFLOW_API_KEY，必须与 Relay 渠道 Key 相同。不能写入 Variables 或桌面安装包。
5. Actions Variables 配置 EJIANBAO_ENABLED=1、EJIANBAO_QUOTA_PER_SECOND；Logto/NewAPI 配置复用原服务。发布受测代码后触发已有 Deploy 流程。
6. Docker 使用持久卷 cqai-account-video:/app/data；SQLite 保存报价、用户归属和幂等映射，不保存原始照片、录音、Token 或厂商 Key。多副本不能使用各自独立数据库；水平扩容前必须迁移共享事务存储。
7. 反向代理至少允许 101 MiB 请求体、超过 6 分钟的创建请求。服务端每份素材限制 50 MiB。
8. 后端与 Relay 确认可用后再发布新桌面包。普通用户只登录平台并充值。

禁用 EJIANBAO_ENABLED 会返回 503，不会误转发到通用模型代理。禁用前先让在途任务结束，避免用户无法查询与下载。

## 恢复与容量

同一用户、同一本地任务 ID 使用持久化幂等键。重启后重复请求查询原任务。创建请求已发送但无法确认结果时返回 VIDEO_SUBMISSION_UNKNOWN，不自动再提交。运维应按本地任务 ID（video_runs.request_key）、服务端 run ID 和 Relay 任务记录核对后恢复映射；不能删除记录再试。超过十分钟仍在素材准备阶段会明确提示人工检查。

本地“停止等待”只停止本地进程；Relay 继续云端轮询、结算。现有 Relay 没有通用取消接口，不能承诺云端取消或退款。

InferFlow 当前账户素材库最多保留 10 张形象和 10 份声音，相同原文件复用已有素材。面向多用户上线前应申请足够容量或确定素材回收方案。此实现不自动删除共享素材，避免误删历史素材或其他任务正在使用的素材。达到上限会报告上传失败。

## 验证

```sh
npm ci
npm run typecheck
npm test
npm run build
node --import tsx/esm scripts/verify-desktop-video.ts --desktop-root ../ebao-studio --python /path/to/python --fixture-video /path/to/6-second-video.mp4
```

最后一条执行真实 JWT 校验、HTTP、SQLite、桌面 Host、Python 标准输入桥接、字幕与 Remotion 导出，云端用测试响应，不代表线上扣费验收。结果保存在 .build/managed-video-*/report.json 和对应 MP4。

Verify managed video CI 在固定 Relay 版本中用真实 Sobek 引擎验证插件元数据、签名和用量字段。

上线验收应由普通用户完成一笔真实充值，核对商户到账及平台积分，再生成短数字人视频，核对只有一个上游任务、一笔最终结算和可播放成片；失败退款与断网恢复也要单独验收。测试 Key 与实付订单需运营方明确选定。
