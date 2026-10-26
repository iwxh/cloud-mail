# Cloud Mail 一键部署（新域名专用）

目标：首次配置授权后，每次只输入一个已经接入 Cloudflare 的新域名，创建独立邮箱项目。

## 当前状态

这是独立部署器，不替换现有的 `npm run deploy`，不会自动更新旧项目。
启用前必须通过离线测试、GitHub 的 Worker 打包检查，并用一个**没有旧邮箱业务的新域名**完成首轮真实验收。
代码分支为 `feat/oneclick-cf-mail`。合并到默认分支前，新工作流可能不会出现在 Actions 的手动运行列表中。
不要为显示按钮而直接合并：当前仓库的 main 仍被部分现有服务自动跟随，必须先安排隔离或暂停相关自动构建。

## 首次准备（只需一次）

1. Cloudflare 账号已开通 Workers Paid，并有可用的 D1、KV、Worker、Cron 和发信额度。部署器不会代购套餐，也不会绕过平台审批。
2. 域名使用 Cloudflare 权威 DNS，区域状态为 Active。仅添加几个指向 CF 的 A/CNAME 记录不等于接入成功。
3. 在 CF Email Routing 的目标地址中验证一个你控制的收件邮箱，用于接收管理员激活码。已验证的地址可以在同一 CF 账号下复用。
4. 在 GitHub 仓库 Settings → Environments 创建 `mail-provisioning`。
5. 在该 Environment 中配置以下 Secrets（不要写进代码或聊天）：

| Secret | 内容 |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | 你的 CF 账号 ID，32 位十六进制 |
| `CLOUDFLARE_API_TOKEN` | 仅授予部署所需权限的 CF API Token，不使用 Global API Key |
| `MAIL_OWNER_EMAIL` | 第 3 步已验证的邮箱，用于接收激活码 |

建议为 Environment 启用 Required reviewers，并限制可使用它的部署分支。
不要把部署 Token 放到邮箱 Worker 中；它只在部署工作流的预检和执行步骤中使用。

### Token 权限

按 CF 当时显示的权限名称配置，限定到目标账号和允许部署的区域。部署器涉及：

- Zone Read、DNS Read/Edit、Zone Settings Read/Edit。
- Workers Scripts Read/Edit、Workers Routes Read/Edit。
- D1 Read/Edit、Workers KV Storage Read/Edit。
- Email Routing Rules Read/Edit、Email Routing Addresses Read。
- Email Sending 的域名管理和发信权限。
- Workers AI 绑定所需权限。

“Edit Cloudflare Workers”预设不一定包含 D1 和邮件服务权限。遇到 403 时补齐对应权限，不要直接换用全局密钥。
如果 Token 只授权了特定区域，后续新域名也必须位于授权范围内。

### 可选默认转发

在同一 Environment 的 Variables 添加 `MAIL_FORWARD_TO_OWNER=true`，可让**管理员邮箱的新来信**在网页保留后转发到 `MAIL_OWNER_EMAIL`。
不填或填 `false` 则不开启转发。新项目默认不把其他用户的邮件集中转给管理员。
转发目标和管理员激活通知使用同一已验证地址；暂不支持每次输入任意新目标。

## 每次新建

1. 将新域名接入 CF，等待 Active。
2. GitHub → Actions → **New Cloud Mail service** → Run workflow。
3. 输入小写域名，例如 `example.com`，不含 `https://`、路径、空格或通配符。国际化域名使用 punycode。
4. 确认运行。它会先只读检查冲突，再创建该域名的独立资源。
5. 查看运行摘要，等待网站 DNS 和证书生效。
6. 到 `MAIL_OWNER_EMAIL` 查收激活邮件（也检查垃圾邮件）。
7. 打开 `https://mail.example.com/setup`，输入邮件中的激活码，自行设置 12–30 字符密码。
8. 登录 `https://mail.example.com/login`，管理员是 `admin@example.com`。

激活码不放在 URL、构建摘要或仓库中。数据库只保存其摘要，有效期 24 小时，使用后失效。
未完成激活时，普通 API、公开注册和登录均不开放；管理员邮箱已预留，可以保存外部来信。
公开注册默认关闭，需要时由管理员在系统设置中开启。

## 自动处理的内容

- 独立 Worker、D1 和 KV；资源名称由域名摘要和部署标识生成，不复制旧数据库 ID。
- 独立随机 `jwt_secret`，作为 CF Secret 保存；重复运行不替换已有密钥。
- 使用原项目初始化代码在本地空 SQLite 中生成当前表结构，再仅初始化部署器拥有的新 D1。
- 新网站地址 `mail.域名` 和管理员地址 `admin@域名`。
- 原生 CF 发信的 `email` 绑定和 CF 返回的认证记录。
- 区域根域名的收信 MX/SPF、收信 DKIM、Catch-all → 本项目 Worker。
- 隐藏 GitHub 图标，关闭默认公告弹窗，保留每日维护 Cron。
- 管理员激活邮件和可选的管理员来信转发。
- 等待 1.1.1.1 和 8.8.8.8 公网解析均匹配 MX、SPF、DKIM、DMARC，再请求发送激活码；退信或被抑制的请求不会报告为成功。

根域名、www 等现有 A/AAAA 记录不会修改。
发现 `mail.域名` 已有 DNS/Worker、其他邮件服务的 MX/SPF、已有生效的收信规则或不属于本部署器的资源时，停止并要求人工检查。
既有 DMARC 策略保留，不自动放宽。

## 失败与重试

- 在同一个 workflow run 上使用 **Re-run jobs**，保持相同源代码提交。
- 进度保存在本项目 KV 的 `_cloudmail_provisioner_v1`，只包含资源标识和进度，不含密码或激活码。
- 原生发信域名创建中断后，可根据预先记录的意图恢复。
- 未激活的项目重跑会生成新的激活码，旧码失效；已激活项目不重置管理员密码。
- 不自动删除数据库、邮件、旧 DNS 或 Worker。未知归属、遗失进度、绑定被手改等情况会停止，不强行接管。
- 如果正好在 KV 创建后、写入归属记录前中断，需要人工核对这个空命名空间；部署器不会仅凭名字认领它。
- CF API 返回的发信套餐限制、审批、额度不足仍需你处理。DNS/TLS 超过等待时间时，稍后重跑。

此命令是**新建/恢复**，不是更新工具。不要用它把已建项目升级到其他源代码提交。

## 验收标准

部署摘要中的“接口接受请求”不等于收件人已经收到邮件。

1. 网站能登录，管理员邮箱和后缀正确。
2. 公网 MX、SPF、DKIM 和 DMARC 正确。
3. 从外部邮箱发一封测试到管理员地址，网页实际出现该邮件。
4. 从正式网站向外部邮箱发送测试，对方实际收到，并检查 CF 日志。
5. 开启转发时，验证网页保留、目标邮箱收到及你的提醒链路。

当前自动检查包括双公网 DNS 解析、网站 HTTPS/部署标识/数据库就绪，以及激活邮件已排队或送达的接口结果。
真实外部收信和目标邮箱收件结果仍需完成上述端到端验收，不会伪报为通过。
CF 原生发信在 QQ 上仍可能显示“代发”；本工具不承诺消除该提示。

## 开发检查

使用 Node 24。数据库结构生成器使用 Node 自带 SQLite 和 VM Modules，因此命令需要相应标志。

```sh
node --experimental-vm-modules --test automation/test/*.test.mjs
pnpm --dir mail-worker install --frozen-lockfile
pnpm --dir mail-vue install --frozen-lockfile
pnpm --dir mail-vue run build
node --experimental-vm-modules automation/check-bundle.mjs
```

设置好本地环境变量后，下面命令只读，不创建资源：

```sh
node --experimental-vm-modules automation/provision.mjs --plan
```

不要在本地打印或提交环境变量。真正创建资源的 `--apply` 只应在已审查的工作流、明确的新域名上运行。
