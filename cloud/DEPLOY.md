# PromptPilot 云端试用版部署

使用独立的 Supabase 项目和 GitHub 仓库。原本机版不受影响；本机 SQLite 和 `.env` 不会自动上传。

## 已准备的内容

- 静态中文网页及邮箱密码登录；登录用户还必须在获准成员表中。
- Supabase Edge Function：所有请求先使用 Auth 验证 JWT，再检查已验证邮箱及获准成员。
- PostgreSQL 数据表、日额度计数、逐案队列、并发领取锁、超时中断记录。
- 直接 Data API 对匿名和已登录用户均无表权限；RLS 开启。应用读写统一经过鉴权后的云函数。
- 默认仅允许向 `api.deepseek.com` 发送模型密钥，禁止 HTTP、重定向和任意外部地址。
- 默认每日最多预留 100 次模型调用（UTC 日期，起草与评测共用）。失败也计入额度，不自动退款/重试。

## 一、构建

```powershell
python scripts/build_cloud.py --admin-email "你的管理员邮箱"
```

无系统 Python 时可以使用本机内置 Python，或运行已准备的构建命令。生成：

- `dist/`：GitHub Pages 网页（只有静态文件与公开配置）。
- `cloud/deploy/01_database.sql`：完整初始化 SQL，带指定的管理员邮箱。
- `cloud/deploy/promptpilot.ts`：可粘贴进 Supabase Dashboard 的单文件云函数。

`cloud/deploy/` 被 Git 忽略，不公开管理员邮箱。公共迁移脚本不会自动添加任何成员。

## 二、初始化 Supabase 数据库

在你新建的 PromptPilot 项目中打开 SQL Editor → New query，粘贴 `cloud/deploy/01_database.sql` 全部内容并运行。

脚本仅创建带 `pp_` 前缀的表与函数，不删除已有表。只在独立的 PromptPilot 项目运行，不在 SimpleTodo 项目运行。

成功后应看到 `pp_members`、`pp_entities`、`pp_jobs`、`pp_quota` 四张表，`pp_members` 中应有你的管理员邮箱。

## 三、创建登录账号

在 Authentication → Users 中使用 Add user / Create new user，为管理员邮箱创建账号并设置密码，由你本人操作，不要将密码发到聊天或写入代码。用于本次受控试用的手工账号需标记邮箱已确认。

同样可为领导创建账号，再在 SQL Editor 执行：

```sql
insert into public.pp_members(email,role)
values ('领导登录邮箱的小写形式','member')
on conflict(email) do update set enabled=true;
```

只有同时具备 Auth 账号和启用的成员记录才能进入应用。所有获准成员共享所有试用项目及报告；只有 admin 可改模型地址和配置。不要向不应读取这些数据的人开放成员资格。

暂停成员资格：`update public.pp_members set enabled=false where email='该邮箱';`。密码找回目前由管理员在 Supabase 处理，网页没有自助注册或找回密码入口。

## 四、设置模型密钥和云函数

在 Edge Functions → Secrets 中添加：

| 名称 | 值 |
| --- | --- |
| DEEPSEEK_API_KEY | 你本人填入真实 DeepSeek 密钥 |
| ALLOWED_ORIGINS | `https://zzldbq.github.io` |
| DAILY_CALL_LIMIT | `100`（可选，最高 1000） |

模型密钥只放 Secrets，不写入网页、SQL、仓库或公开配置。运行时 Supabase 自动提供 `SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY`，不要把它们放前端。

创建名为 **promptpilot** 的 Edge Function，选择 Dashboard 编辑器，使用 `cloud/deploy/promptpilot.ts` 全文替换示例内容，部署。

本项目函数的 `verify_jwt` 配置为 false：网关层不执行旧 JWT 检查，函数内部对每个业务请求调用 Supabase `/auth/v1/user` 验证用户 JWT，并检查成员表。它不是匿名业务接口；仅 OPTIONS 预检不需登录。使用 CLI 时配置已在 `supabase/config.toml`；使用 Dashboard 时对应开关通常为 Verify JWT / Verify JWT with legacy secret，关闭后由代码完成验证。不要删除代码中的用户验证或成员检查。

如以后接入其他模型，管理员须同时设置 `MODEL_ALLOWED_HOSTS`（逗号分隔的 HTTPS 域名）、`MODEL_KEY_NAMES`（逗号分隔的模型密钥变量名）及相应 Secrets。默认只允许 DeepSeek 和 `DEEPSEEK_API_KEY`。

## 五、GitHub Pages

使用独立仓库 `zzldbq/promptpilot`。上传经过清理的代码；绝不上传 `.env`、`data/`、个人案件、原始公司 PRD 或 `cloud/deploy/`。

仓库 Settings → Pages → Source 选择 **GitHub Actions**。推送 main 分支后，`.github/workflows/pages.yml` 会运行测试、构建 `dist/` 并部署网页。

预期地址为 `https://zzldbq.github.io/promptpilot/`，以 Actions 实际成功输出为准。部署成功之前不要把它当成已可用地址。

## 六、验收顺序

1. 未登录只能看到登录页；输入正确账号后进入工作台。
2. 创建完整演示项目，确认 C/D 退化和双模型固定演示标识。
3. 登录第二个获准账号，确认可以读取同一项目和保存复核。
4. 模型显示密钥已配置后，先跑 V1 + 一案验证真实接口。
5. 再跑 V1/V2 + 四案，核对真实报告。
6. 未获准账号、无 JWT 请求、直接用 publishable key 访问数据表应被拒绝。
7. 页面关闭后重新登录，待执行的案件可继续；已超出租约的调用标为错误，不自动重复计费。

## 运行边界

- 这是共享试用工作台，不做按项目分配成员。仅放虚构数据。
- 网页保持开启才能持续推进队列。已开始的云端调用独立执行，但关闭页面后剩余排队案件不会保证自动运行；下次登录继续推进。
- 单次最多 200 个调用、单例超时 60 秒、队列租约 2 分钟；全工作台同一时刻一个队列任务在执行。
- 依赖云端平台可用性，不承诺免费额度、永不休眠或特定网络可达性。
- 原本机数据未迁移。云端从空库或新建演示开始，不会自动上传本机历史。
- 字段校验与本机规则一致，包括整数/浮点数差异；云端额外拒绝超出 JavaScript 精确表示范围的整数。
- publishable key 可以出现在网页中，但不能替代登录、成员授权或服务端密钥。

## 本地验证

```text
python -m unittest discover -s tests -v
node --test tests/frontend.test.cjs tests/cloud.test.mjs
python scripts/build_cloud.py
```

当前本地自动化覆盖校验、权限拒绝、密钥不外泄、单任务模型请求、错误保存及原前端保护。真实 Supabase SQL/函数部署、云端登录和真实 DeepSeek 端到端运行仍需完成上述部署后验证。
