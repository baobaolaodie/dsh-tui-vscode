<div align="right">

[English](CONTRIBUTING_EN.md) · 中文

</div>

# 贡献指南（dsh-tui-vscode）

感谢你考虑为 dsh-tui-vscode 做贡献！以下是参与开发的流程与约定，**均由 CI 服务端强制**（贡献者无法通过修改仓库文件削弱检查）。

## 开发环境

- Node.js 24（开发与 CI 一致）；包管理用 **npm**（`npm ci` 安装）。
- e2e 的"真实 dsh-tui 恢复测试"需要本机全局安装 `dsh` CLI 与 `dsh-tui`（无则自动跳过该用例）。
- 开发时建议安装本地钩子：`node scripts/install-commit-hook.mjs`（拦截提交消息格式等快速可逆问题）。

## 运行测试

```bash
npm run typecheck        # tsc --noEmit
npm test                 # 编译 + 数据层单元测试（node:test）
npm run test:e2e         # 真实扩展宿主测试（@vscode/test-electron；Linux 用 xvfb-run -a）
npm run package          # 编译 + 生成 .vsix
```

## 变更流程

1. 从 `main` 创建功能分支，**分支前缀**必须是 `feat/` `fix/` `docs/` `chore/` `hotfix/` `ci/` `test/`（CI pr-policy 强制，`feature/` 会被拒绝）。
2. 提交消息遵循 **Conventional Commits**：`fix: ...` / `feat: ...` / `docs: ...` / `ci: ...`（CI 逐个提交审计）。
3. 发起 Pull Request：**标题同样遵循 Conventional Commits**；正文使用 `.github/PULL_REQUEST_TEMPLATE.md` 的五段结构（摘要 / 改动范围 / 验证 / 自查 / 审查注意点），**删除或省略任何段落或勾选项即失败**。
4. 行为变化**必须记入 `CHANGELOG.md` 的 Unreleased 段**（中英同步）；勾选"行为变化已记入 CHANGELOG"时，分支必须相对基线有实际的 CHANGELOG diff（防虚假自查）。
5. 文档改动必须**中英双语同步**（CI 强制行数差 ≤ 10，CoC 除外）。

## 代码约定

- 与 VS Code API 无关的纯逻辑放 `src/session.ts` / `src/sessions.ts`，**不带 `vscode` import**，便于单元测试。
- **断言平台无关**：路径分隔符用 `join()` 构造期望值；CI 在 Linux 与 Windows 双平台运行，Windows 风格硬编码断言会在 Linux 失败（已有前车之鉴）。
- 只暂存显式路径，不用 `git add -A` 大杂烩；提交前自查 `git diff --check`。
- 不提交凭据、密钥、个人路径或本地产物（`.vsix`、`.e2e-workspace` 等已在 `.gitignore`）。

## 提交规范

- 每个变更单独提交，勿混入无关改动。
- 提交信息：`<type>(<scope>): <subject>`，如 `fix(sessions): projectNameOf 双分隔符解析`。

## 提交流程

1. Fork 本仓库，从 `main` 建分支（`git checkout -b fix/your-change`）。
2. 提交改动（`git commit -m 'fix: describe the change'`）。
3. 推送到分支（`git push origin fix/your-change`）。
4. 发起 Pull Request（标题同样遵循 Conventional Commits 前缀）。

本地预检：安装 pre-commit 钩子（`node scripts/install-commit-hook.mjs`），CI 服务端兜底其余检查。
