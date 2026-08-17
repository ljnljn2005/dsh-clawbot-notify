# dsh-clawbot-notify

DSH（DeepSeek Harness）插件：任务完成 / 报错 / 需要用户选择时，通过**个人微信**（ilink 协议，Weixin ClawBot 通道）发送主动通知。内置微信扫码登录流程，无需第三方 webhook 服务。

> 技术参考：[codex-wechat](https://github.com/demoadminjie/codex-wechat)（ilink API 对接 + 账号存储）、[dsh-wechat-notify](https://github.com/wssfk12138/dsh-wechat-notify)（DSH 插件形态）、[@claw-lab/wxclawbot-cli](https://github.com/lroolle/wxclawbot-cli)（主动发送协议）。

## 特性

| 特性 | 说明 |
|---|---|
| 主动推送 | 直接调 `ilink/bot/sendmessage` 给微信发消息（无需对方先发消息） |
| 三个事件 | 任务完成（✅） / 报错（❌） / 需用户选择（❓） |
| 内置登录 | 工具 `clawbot_login` 生成二维码 → `clawbot_login_confirm` 轮询确认并保存凭据 |
| 复用账号 | 凭据存 `~/.codex-wechat/accounts/`，与 codex-wechat 完全兼容 |
| 幂等 | 同一错误/询问按 `agent:turn:step` 去重，不重复轰炸 |
| 失败隔离 | 发送失败只记日志，绝不影响 dsh 主流程 |
| 限速识别 | 识别微信 `ret=-2`（约 7 条/5 分钟限速）并给出提示 |

## 安装

```sh
dsh plugin --profile web add github:ljnljn2005/dsh-clawbot-notify
dsh plugin --profile headless add github:ljnljn2005/dsh-clawbot-notify   # 可选
```

profile 的 `cordis.patch.yml` 中启用：

```yaml
- insert:
    - id: clawbot-notify
      name: 'dsh-clawbot-notify'
      config:
        title: 'DSH 提醒'
```

## 使用步骤

1. **首次登录**：在任务中让 agent 调用 `clawbot_login` → 用微信扫二维码 → 手机上确认 → 调用 `clawbot_login_confirm`。凭据自动保存。
2. **日常使用**：无需任何操作，任务完成/报错/需选择时自动收到微信通知。
3. **查看状态**：可让 agent 调用 `clawbot_account` 查看当前登录账号与目标。

## 配置项

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `title` | string | `DSH 提醒` | 通知标题前缀 |
| `notifyComplete` | boolean | `true` | 任务完成时通知 |
| `notifyError` | boolean | `true` | 任务出错时通知 |
| `notifyQuestion` | boolean | `true` | 需要用户选择时通知 |
| `baseUrl` | string | `https://ilinkai.weixin.qq.com` | ilink 服务地址 |
| `token` | string | `""` | 微信 bot token（可选，留空读账号文件） |
| `toUserId` | string | `""` | 目标用户 ID（可选，留空发给自己/账号绑定用户） |
| `accountId` | string | `""` | 多账号时指定；留空用最近登录的 |
| `accountsDir` | string | `~/.codex-wechat/accounts` | 账号文件目录 |
| `timeoutMs` | number | `15000` | 发送超时 |
| `maxContentLength` | number | `500` | 消息正文最大字符数 |
| `dryRun` | boolean | `false` | 试运行：只记日志不真发 |

## 本地测试

```sh
node test/test.mjs
```

用 mock ilink 服务器验证：发送 body 结构（主动推送 `context_token` 为空）、`ret=-2` 限速处理、登录流程与凭据落盘、事件触发端到端发送。

## License

MIT