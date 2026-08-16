<div align="right">

[English](SECURITY_EN.md) · 中文

</div>

# 安全政策

## 受支持版本

| 版本 | 支持 |
|---------|-----------|
| 0.5.x | ✅ |

## 报告漏洞

**请不要在公开 issue 中披露安全漏洞。** 请通过以下方式私下报告：

- **推荐**：使用 GitHub Security Advisories（仓库页面 → Security → Report a vulnerability）——官方私有报告通道，报告者匿名、修复前不公开；
- 或通过 GitHub 联系维护者（https://github.com/baobaolaodie）。

项目维护者会在一周内响应。

## 安全设计说明

- **无凭据入库**：仓库历史与工作树经全历史审计，无 API 密钥、Token、私钥或带凭据 URL；CI 的 security-scan job 持续兜底 HEAD 级增量防线。
- **密钥由环境注入**：`DEEPSEEK_API_KEY` 只从运行环境读取，扩展与 TUI 均不把明文写入任何文件。
- **会话承载**：会话运行在 VS Code 集成终端内，进程与信号由 VS Code 管理；扩展只发送启动命令。
- **凭据文件防线**：`.env` / `*.key` / `*.pem` 等已被 `.gitignore` 排除，CI 检查已跟踪文件中的凭据类文件名。
