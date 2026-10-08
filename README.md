# PromptPilot

中文提示词设计与回归评测工作台。支持版本对比、逐案确定性校验、退化定位、多模型对比与人工复核。示例均为虚构数据，固定演示结果明确标记。尚未接入 Agent Flow。

## 云端部署

请按 [部署手册](cloud/DEPLOY.md) 初始化独立 Supabase 项目并启用 GitHub Pages。前端仅含公开配置；模型密钥仅放 Supabase Secrets。

## 本机运行

Python 3.10+：`python server.py`，打开 http://127.0.0.1:8765 。Windows 也可运行 `powershell -ExecutionPolicy Bypass -File .\start.ps1`。无需安装第三方依赖。复制 `.env.example` 为 `.env` 配置模型密钥。SQLite 数据保存在 `data/`。

## 测试

`python -m unittest discover -s tests -v`

`node --test tests/frontend.test.cjs tests/cloud.test.mjs`
