# 通用 QQ 发信修复模板

分支：`qq-sender-template`；合并本模板后的 `main` 也可使用相同部署流程。

本分支包含已经在 QQ 邮箱实测通过的 Sender 修复，保留 Resend。
它不包含任何现有项目的 Worker 名称、D1/KV ID、域名或密钥。
以后多个新项目可以共用本分支，不需要为每个域名单独修改代码或新建分支。
QQ 的显示规则由收件平台决定，新域名上线后仍需实测；不保证其他邮箱也不显示“代发”。

第一次搭建请先看 [新项目图文部署教程](DEPLOY-GUIDE.md)，或直接打开 [部署流程图](doc/images/deploy-guide.png)。

**与原项目的区别：本通用模板新增了 4 个构建变量，用于隔离各项目的 Worker、D1 和 KV；它们不是 QQ Sender 修复本身所需的参数。必须先创建独立 D1/KV，再填写构建变量并构建，构建成功后才配置运行时变量、初始化和注册。不是一键自动创建所有资源。**

## 1. 每个新项目准备独立资源

创建新的 Worker、D1 数据库、KV 命名空间，记录它们的名称和 ID。
不要填已有邮箱项目正在使用的资源，否则仍然会共用其账号和邮件数据。
模板不会自动创建资源，也不会自动初始化、清空或迁移数据库。

## 2. Cloudflare 构建设置

将新 Worker 连接到本仓库，设置：

| 设置 | 值 |
| --- | --- |
| 生产分支 | `qq-sender-template`，或已经合并本模板的 `main` |
| 根目录 | `/mail-worker` |
| 构建命令 | 留空 |
| 部署命令 | `npm run deploy` |
| 非生产分支构建 / 预览构建 | 关闭 |

新版 Cloudflare 界面需进入“构建 → 预览基础”，将“预览分支构建”关闭。
只查看“生产”标签页，不能确认预览是否已经关闭；保存后应重新核对开关状态。

在“构建”的变量和密钥中添加以下四个**构建变量**：

| 变量名 | 填写内容 |
| --- | --- |
| `MAIL_WORKER_NAME` | 当前新 Worker 的名称，必须与 Cloudflare 项目名称一致 |
| `MAIL_D1_DATABASE_NAME` | 当前新 D1 数据库名称 |
| `MAIL_D1_DATABASE_ID` | 当前新 D1 数据库 UUID |
| `MAIL_KV_NAMESPACE_ID` | 当前新 KV 命名空间的 32 位 ID |

这些是本模板新增的构建参数，不是 Cloudflare 自动提供的参数。
必须填写在“构建变量”区域，不能只填在“运行时变量”区域。
Worker 名称使用小写字母、数字和连字符；数据库名称使用字母、数字、下划线和连字符。
所有变量均不加引号，名称和值不可套用现有服务。

部署入口会先校验参数，再生成该项目自己的临时 Wrangler 配置、构建前端并部署。
配置缺失、格式不正确或 Workers Builds 分支不是 `main` / `qq-sender-template` 时会停止，不会回退使用旧资源。
参数只校验格式，不能替你确认填入的 ID 是否确实属于新项目，部署前仍须核对。

**不要使用默认的 `npx wrangler deploy`。** 本分支的旧 Wrangler 入口已锁定为不可部署占位配置，
避免误用旧的项目绑定。`wrangler.generated.json` 只在部署时临时生成，结束后删除，不提交 Git。

## 3. 首次部署后的运行时配置

在新 Worker 的“运行时变量和密钥”中配置本项目自己的：

| 名称 | 内容 |
| --- | --- |
| `domain` | JSON 数组，例如 `["mail.example.com"]`，不要带 `@` |
| `admin` | 完整管理员地址，例如 `admin@mail.example.com` |
| `jwt_secret` | 为新项目生成的独立随机密钥，使用 Secret 类型，不复用旧项目的值 |
| `project_link` | 可选，文本 `false` 隐藏登录页右下角 GitHub 图标 |

构建变量不会自动成为运行时变量。模板使用 `keep_vars: true`，后续代码部署保留后台配置的变量。
模板不提供域名或密钥默认值，所以配置运行时变量、完成数据库初始化前不能正常登录。
全新数据库按照原项目初始化流程设置，切勿对已有业务库重新初始化。

另外按新项目正常配置自定义域名、Email Routing Catch-all 指向当前 Worker、Resend 域名与 Token。
本模板不会代你设置 DNS，也不会自动选择或复制其他项目的 Token。
高级 R2 / Cloudflare 发信绑定仍需单独配置，本模板只提供标准 D1 + KV + Resend 部署。

关闭公告：登录新项目后台，进入“系统设置 → 网站公告 → 登录弹窗 → 关闭 → 保存”。

## 4. 上线检查

1. 确认当前 Worker 的 `db`、`kv` 绑定确实是该新项目的资源。
2. 完成初始化后验证管理员登录，检查是否出现其他项目的账号或邮件。
3. 验证外部收信和 Resend 发信。
4. 向自己的 QQ 邮箱发送新邮件，确认没有“代发”，并测试一次回复。
5. 后续更换资源时同时维护四个构建变量，不要仅在绑定页面换成另一个 ID，否则下次构建会覆盖回来。

多个项目共用此分支后，向本分支提交代码会触发所有连接它的项目构建；每个项目使用各自的构建变量。
更新本模板前应先验证，再统一发布。现有 kg、pl、zmail 项目无需切换到本分支。

## 本地检查

```sh
cd mail-worker
npm run test:template
npm run check:template
```

`test:template` 不需要密钥、不访问网络、不发送邮件。
`check:template` 需要上述四个环境变量，只校验配置，不创建资源、不部署。
`npm run deploy -- --dry-run` 会构建前端并让 Wrangler 本地打包，不上传生产；需要已安装依赖及 pnpm。
直接运行部署命令才会真正部署，请只在确认四个变量指向目标项目后执行。

本模板的 GitHub Actions 在提交、合并请求和手动运行时执行离线测试以及 Linux 实际打包检查。
打包使用示例资源 ID 和 Wrangler `--dry-run`，不上传 Cloudflare，不使用仓库中已有的部署密钥。
该流程已通过前端构建、Worker 打包、产物存在检查及临时配置清理检查；上线新域名仍需完成实际收发验证。
历史 Cloudflare 检查失败不会因新提交自动消失；应查看最新提交对应的测试和构建结果。

## 从旧 main 迁移

本模板与旧版 `npx wrangler deploy` 的部署入口不同，不能直接替换现有项目的构建配置。
如果已有 Worker 连接旧 `main`，合并模板前先暂停其自动构建，或保留独立的旧版维护分支。
保持线上版本、原数据库和 KV 不变。只有完成四个构建变量及部署命令迁移后，才能重新启用自动构建。
切勿为了让检查变绿而给模板测试配置现有业务数据库 ID，或直接重试旧项目的失败部署。

## 参考

- [Cloudflare 构建配置及构建变量](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
- [Wrangler 配置与 keep_vars](https://developers.cloudflare.com/workers/wrangler/configuration/)
