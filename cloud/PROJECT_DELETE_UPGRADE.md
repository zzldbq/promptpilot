# 删除项目功能启用

1. 如还未完成测试集升级，先执行 `supabase/migrations/202610140001_case_suites.sql`。
2. 在 Supabase SQL Editor 新建查询，执行 `supabase/migrations/202610140002_delete_project.sql`。这一步仅安装删除函数和关联检查，不会立即删除任何项目。
3. 在 Edge Functions → promptpilot → Code，用重新构建的 `cloud/deploy/promptpilot.ts` 替换全文并部署。Secrets 和 JWT 设置保持原样。
4. 刷新网页，管理员在项目概览可以点击“删除项目”。输入完整项目名称后才能提交；运行中项目禁止删除。

删除会清除所选项目的版本、案件、测试集、运行、结果及复核，无撤销入口；模型配置、账号、其他项目和全局调用额度记录保留。成员即使直接调用 API 也会被拒绝。

后端旧版本时网页提示功能待启用，不应把文件发布成功理解为云端数据库已升级。仅用新建的可丢弃测试项目验证，不使用实际业务项目做删除测试。
