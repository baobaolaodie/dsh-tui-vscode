# Pull Request

## 摘要 / Summary

<!-- 标题须为 Conventional Commits：<type>(<scope>): <subject>，如 fix: ... / feat: ... / docs: ... / ci: ... -->
<!-- Title must be Conventional Commits: <type>(<scope>): <subject>, e.g. fix: ... / feat: ... / docs: ... / ci: ... -->
<!-- 结构引导：动机（为什么做）→ 做法（改了什举）→ 影响（影响范围与验证依据） / Structure: Motivation → What changed → Impact -->

## 改动范围（勾选）/ Scope of Changes (check)

<!-- CI 校验勾选项完整性：删除或省略任何一项（含未勾选的）即失败——保留完整清单 -->
<!-- CI validates checkbox completeness: deleting or omitting any item (including unchecked ones) fails the PR. -->

- [ ] 核心逻辑（终端 / 会话）/ Core logic (terminal / session)
- [ ] 会话历史（侧边栏）/ Session history (sidebar)
- [ ] 文档（README / docs / CHANGELOG / CONTRIBUTING）/ Docs
- [ ] 其他 / Other:

## 验证（勾选已执行）/ Verification (check executed)

<!-- 关键验证输出请粘贴到验证段下方；reviewer 可直接核验，不能只看勾选——输出才是证据 -->
<!-- Paste key verification output below so reviewers can check directly (checkboxes alone are not evidence) -->

- [ ] 单元测试 / Unit tests（命令 + 结果 / command + result）:
- [ ] 手动验证 / Manual verification（描述场景 / describe the scenario）:
- [ ] 文档改动：中英双语同步 / Doc changes: EN and ZH mirrored
- [ ] 关键验证输出已粘贴至验证段下方 / Key verification output pasted below
- [ ] 如有未运行的验证项（说明原因）/ Not run if any (explain):

## 自查（勾选）/ Self-check (check)

- [ ] 行为变化已记入 CHANGELOG(Unreleased)/ Behavior changes recorded in CHANGELOG (Unreleased)
- [ ] 版本号与实现一致 / Version number matches the implementation
- [ ] 无无关文件或本地伪影 / No unrelated files or local artifacts

## 基于版本 / Based on

<!-- 基于哪个基线开发：最近发布版本？最新默认分支？具体 commit？ / Which baseline (e.g. latest release, latest default branch, specific commit) -->

## 关联（可选）/ Related (optional)

<!-- 仅本 PR 解决的 issue 用 Fixes/Closes/Resolves #N；非解决性事项用文字描述，不要引用 issue 编号 -->
<!-- Only use Fixes/Closes/Resolves #N for issues this PR actually resolves; for anything not resolved, describe it in text without referencing issue numbers -->

## 审查注意点 / Review Notes

<!-- reviewer 需特别关注的点 / Points the reviewer should pay special attention to -->
