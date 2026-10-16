<div align="right">

[English](session-history.md) · 简体中文

</div>

# 会话历史——这份列表从哪来

侧边栏是本扩展最复杂的一块：它要读另一个程序写在磁盘上的状态，还要在那个程序持续写入的同时保持正确。本文记录数据来源、容错手段，以及实现与意图唯一不一致的地方。

## 会话存放位置

根目录按以下顺序解析：

1. `$DSH_TUI_SESSION_ROOT`（若已设置）——它压过一切，包括 `dshHome` 设置。
2. `<dshHome>/sessions`，其中 `dshHome` 依次取 `dsh-tui-vscode.dshHome` 设置、`$DSH_HOME`、`~/.dsh`。
3. `~/.dsh-tui/sessions`，旧版位置。

组目录里每个会话各自一个目录。日志文件带「代」标记：`session.jsonl`、`session.jsonl.zstd`，或 `session.v<N>.jsonl[.zstd]`。DSH 0.2.0-rc.2 写的是格式版本 4，因此当前的产物名是 `session.v4.jsonl.zstd`——提这一点只是因为它说明匹配器取的是**最新一代**，而不是某个固定文件名。

## 容错地读日志

日志是**多帧串联的 zstd**：TUI 每次 durable flush 追加一帧，所以整 buffer 一次解压会失败或截断。扩展按 RFC 8878 的帧结构逐帧遍历，只定位边界而无需解压，并从三个方向容错：中段坏帧靠 zstd magic 重同步，尾部帧以 EOF 锚定，而承载最新标题的尾部帧绝不会被丢弃。

读取是**有界**的：64 KB 头部（最多 128 帧）与 128 KB 尾部。文件中段永不读取，因此 15 MB 的日志只花约 192 KB I/O。尾部只对通过过滤的会话才去取。非 zstd 日志（更早的 gzip 或纯文本格式）回退为整文件读取。

## 标题

标题取第一个能给出的来源：

1. 日志自身的 `session/title` 事件——最后一条胜出。
2. dsh storage 账本。自 DSH 0.1.5 起主形态是按会话存放的 `storages/session_projcache/sessions/<id>.json`（`rows.title.val`，其次 `rows.titleInput.val.first.text`）；更早的扁平 `storages/session_projcache.json`（`tables.sessions[<id>].rows.title.val`）是兜底。Web 会话列表读的是同一个账本。
3. 首条真人消息，来自 `user/message` 或 `agent/inbox/spliced` 中 `source.kind === 'user'` 的那些。
4. 工作目录名。
5. 本地化的「未命名会话」占位。

重命名会追加一帧 `session/title`，`seq = maxSeq + 1`。append-only 的含义是扩展永不重写健康的日志、也永不阻塞 TUI；它**不是**「序号必然唯一」的保证——`maxSeq` 来自扩展自己的有界读取，因此 TUI 在这中间追加的帧可能拿到同一个 `seq`。它真正的代价是：运行中的 TUI 要等到重读日志才看得到新标题。而已经带着旧版本写下的裸 title 行的日志，则改用原子替换就地升级——继续追加并不能修好它们。

## 列表显示什么

过滤口径与 dsh web 列表的默认视图一致：

- **只显示当前工作区。** 会话的 cwd 与某个工作区根精确相同或位于其下即算属于该工作区。容器目录——`$HOME`、盘根、UNC 根——只接受精确匹配，所以打开 `$HOME` 不会把底下所有会话一网打尽。多根工作区取并集。
- **不显示只有启动记录的会话。** 没有任何真人 prompt 的会话会被隐藏，这就是 `hideEmpty` 的含义。不可读或未知的日志绝不因此被隐藏：未知一律「保留」。
- **不显示子代理派遣运行**（`origin: 'subagent'`）。
- **不显示已归档会话。** 归档状态存放在 `storages/workspace.json` 的 `global.archivedSessionIds`——与 dsh web 列表同一个集合。写的是**整份文件**的读取-替换，而不是就地编辑那个集合，因此是 last-write-wins：期间另一个 dsh 写入者对该文件的改动会丢失，正如两个 dsh 进程之间本来就会发生的那样。会话日志全程不动，所以取消归档即可恢复原位。

组内按 `~/.dsh-tui/last-used.json` 的最近使用时间排序，其次按创建时间降序。没有 last-used 记录的会话排在所有有记录的会话之后。

目录变化时树以 500ms 防抖刷新。`fs.watch` 不是递归的，所以每次重新加载还会补上自上次以来新出现的组目录。

## 实现与意图之间的缺口

provider 自己的注释写着：没有打开工作区时，没有会话可归属，于是由欢迎视图出面招呼。但数据层不同意：它把空的 `workspaceDirs` 数组当作「不过滤」，而 provider 在没有打开文件夹时传的正是空数组。

于是在没有打开文件夹的窗口里，侧边栏会列出 DSH home 下的**全部**会话而不是一个都不列，启动/恢复的欢迎视图也永远不会出现。README 记录的是这个**实际行为**；注释描述的是意图行为，而修复应当单独成为一个变更。
