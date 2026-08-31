# 上游同步与升级验证流程

本文档记录 All API Hub 二次开发分支同步官方上游时的标准操作。目标是让后续维护者可以先隔离验证，再把确认无误的上游改动合入功能开发分支。

## 当前仓库关系

- 官方上游：`https://github.com/qixing-jk/all-api-hub`
- 当前 fork：`https://github.com/kim2020112/all-api-hub`
- 功能开发分支：`feature/model-hub`
- 官方同步基线：`upstream/main`
- 模型筛选功能提交：`0c02af5`、`c702b34`
- 最近一次已验证的上游合并：`7f0fb7b3`，基于官方 `7ee200db`（v3.59.0/Nightly）

`main` 是上游同步基线，不包含模型筛选功能。包含二次开发功能的主开发线是 `feature/model-hub`。除非明确要求重建官方基线，不要把功能分支直接覆盖到 `main`。

## 标准流程

### 1. 检查工作区

```powershell
git status --short
git branch --show-current
git remote -v
git log --oneline --decorate -12
```

保留用户已有的未提交修改。不要使用 `git reset --hard` 或 `git checkout --` 清理工作区。

### 2. 创建隔离升级分支

```powershell
git switch feature/model-hub
git branch backup/feature-model-hub-before-upstream feature/model-hub
git switch -c codex/upstream-upgrade-analysis
git fetch upstream --tags
```

如果网络受限，允许申请网络权限重试 `git fetch`。若仓库中存在残留的空 `.git/index.lock`，先确认没有 Git 进程，再删除该锁文件。

### 3. 保护未提交修改

合并前必须暂存工作区改动，尤其是模型筛选文件和本地化文件：

```powershell
git stash push -m codex-upgrade-local
```

只恢复自己创建的 stash。不要误弹出 lint-staged 或其他工具自动创建的 stash。

### 4. 合并并检查冲突

```powershell
git merge upstream/main --no-commit --no-ff
git status --short
git diff --cached --stat
```

重点检查以下目录是否发生冲突或被上游重写：

- `src/features/ModelHub/`
- `src/services/modelList/`
- `src/services/verification/`
- `src/public/_locales/`
- `wxt.config.ts`

如果自动合并失败，按文件语义处理冲突：保留上游基础设施修复，保留 ModelHub 的产品逻辑；不要用整文件覆盖的方式解决冲突。完成后再创建合并提交。

### 5. 验证升级结果

至少执行：

```powershell
node_modules/.bin/tsc.cmd --noEmit
node_modules/.bin/vitest.cmd run tests/features/ModelHub
node_modules/.bin/wxt.cmd build
```

人工验证时使用开发版：

```powershell
pnpm.cmd run dev
```

然后在浏览器中加载 `.output/chrome-mv3-dev`，检查扩展版本、选项页、ModelHub、账号/密钥管理和已有核心流程。开发服务器需要保持运行以支持热更新。

### 6. 合入功能开发分支

确认测试和人工检查通过后：

```powershell
git stash pop
git switch feature/model-hub
git merge --ff-only codex/upstream-upgrade-analysis
```

如果 `stash pop` 出现冲突，优先保留用户未提交的本地改动，并重新运行编译和 ModelHub 测试。合入后再次确认：

```powershell
git status --short
git log --oneline --decorate -4
```

默认只合并到本地分支。推送到 `origin` 需要单独确认，不要在未获授权时执行 `git push`。

## 回退方式

本次升级前应存在备份分支：

```powershell
git switch backup/feature-model-hub-before-upstream
```

如果已在功能分支创建错误的本地提交，优先使用 `git revert`；不要对共享分支执行破坏性重置。

## 本次升级记录

2026-08-31 已完成一次真实验证：

- 官方上游从 `v3.56.0` 更新到 `v3.59.0`/`7ee200db`；
- 46 个上游提交与 ModelHub 二次开发自动合并，无冲突；
- ModelHub 测试 27/27 通过；
- TypeScript 编译通过；
- Chrome 开发版和生产构建通过；
- 已合入本地 `feature/model-hub`，合并提交为 `7f0fb7b3`；
- 原有本地未提交修改已恢复并保留。

后续上游更新时，Codex 应优先阅读本文件，再重复“隔离分支 -> 合并 -> 测试 -> 人工检查 -> 合入功能分支”的流程。
