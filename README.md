# pi-remote

通过 ntfy 将 Pi 的状态通知发送到手机。需要 Node.js 22.7+ 和支持 `agent_settled`、`ui_prompt_start` 等事件的新版 Pi。

## 安装与设置

```sh
pi install git:github.com/CrossStar/pi-remote
```

启动 Pi（已有会话先执行 `/reload`），然后输入 `/push setup`。依次填写 ntfy 服务 URL、主题，以及发布 token 文件的绝对路径。服务无需认证时可留空 token 文件路径。不要在聊天、斜杠命令或输入框中粘贴 token。

向导使用文件读取凭据，因为普通 UI 输入框不提供密码遮罩。可在独立 Bash 终端中安全创建文件：

```bash
mkdir -p ~/.config/pi-remote
chmod 700 ~/.config/pi-remote
(umask 077; read -rsp '发布 token: ' token; printf '\n'; printf '%s' "$token" > ~/.config/pi-remote/publisher-token)
chmod 600 ~/.config/pi-remote/publisher-token
```

设置完成执行 `/reload`，再用 `/push test` 发送测试通知。环境变量优先于文件设置。

## 手机订阅

安装 ntfy 手机客户端，添加与设置相同的服务器和主题，并允许系统通知。私有服务器需配置有该主题读取权限的账号或 token；发布端只需写入权限。主题名本身不构成访问控制。iOS 自建服务的即时推送可能需要 ntfy upstream 配置，参阅 ntfy 官方文档。

## 命令

| 命令 | 功能 |
| --- | --- |
| `/push setup` | 交互设置，Esc 取消且不保存 |
| `/push on` | 当前会话开启 |
| `/push off` | 当前会话关闭并清空队列 |
| `/push status` | 查看配置是否有效及发送计数，不显示凭据 |
| `/push test` | 将测试消息入队 |

## 配置

配置文件为 `$XDG_CONFIG_HOME/pi-remote/config.json`；XDG 未设置或非绝对路径时使用 `~/.config/pi-remote/config.json`。目录权限 0700，JSON 和 token 文件权限 0600。配置通过临时文件重命名原子保存，在启动及 `/reload` 时加载。无效配置会禁用推送，可重新运行向导修复。

```json
{
  "url": "https://ntfy.example.com",
  "topic": "my-private-topic",
  "tokenFile": "/absolute/path/to/publisher-token",
  "enabled": true,
  "excerpt": false
}
```

`url` 和 `topic` 必填，其余可省略；tokenFile 必须为私有普通文件的绝对路径。URL 不得含用户名、密码、查询或片段。默认启用，默认不发送内容摘录。

环境覆盖：`PI_PUSH_URL`、`PI_PUSH_TOPIC`、`PI_PUSH_TOKEN`、`PI_PUSH_ENABLED`（`0` 关闭）、`PI_PUSH_EXCERPT`（`1` 开启回答摘录）。不要将含 token 的环境文件提交到 Git。凭据由本机文件保存，不写入 Pi 会话。

## 行为与限制

通知包括运行结束或中止、持续超过 1.5 秒的交互等待、上下文压缩失败。运行结束仅代表 Pi 可继续输入，不代表任务成功。默认不发送提示词、回答、路径或工具输出；开启 excerpt 会发送最多 400 字符的回答摘录。

队列最多 16 条，每条最多 800 字符，每次请求超时 5 秒；网络错误、429、5xx 最多尝试 3 次，可能重复通知。关闭或退出会丢弃待发消息。服务器接受不保证手机收到，网络、权限、系统省电策略都可能影响送达。HTTP 不加密，应使用 HTTPS。扩展仅推送状态，不提供手机远程控制。

`deploy/` 提供可选自建服务示例，需自行配置域名、认证授权及 tunnel；请勿提交实际 server.yml、数据库或环境文件。

## 开发

```sh
npm install
npm run typecheck
npm test
```

测试使用临时 HOME/XDG 目录和模拟网络，不读取用户真实凭据。项目尚未指定许可证。
