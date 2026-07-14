# Codex 自动续跑守护

目标只有一个：任务仍然在 Codex 里创建和完成；如果它因为用量上限停下，额度恢复后继续同一个任务，而不是让用户再去另一个应用重建一遍。

菜单栏 App 只是本机后台守护和状态页。它不提供第二套任务创建表单。

> 这是一个独立、非官方的本机工具，与 OpenAI 不存在隶属、授权或背书关系。Codex、OpenAI 及相关名称和商标归其各自权利人所有。

## 怎么使用

1. 启动 `CodexResumeManager.app`。它会驻留菜单栏并默认加入登录项。
2. 进入本仓库目录，安装随仓库提供的 Codex 插件：

   ```bash
   cd <repo-path>
   codex plugin marketplace add "$PWD"
   codex plugin add codex-auto-resume@codex-resume-manager-local
   ```

3. 第一次使用时，在 Codex 输入 `/hooks`，信任“自动续跑” Hook。这是 Codex 的一次性本机安全确认。
4. 在需要守护的 Codex 任务中说：`开启自动续跑`。

Codex 只有在收到后台的匹配确认后才会回复“已开启”。如果应用还在启动，
会明确显示“已提交但尚未确认”，不会把写入命令误报成已经生效。
这些开关与状态查询会被 Hook 在本机处理，不会继续发给模型消耗额度；对应的
控制 turn 会被守护单独识别，不会误判成用户手动继续原任务。

之后继续像平常一样使用 Codex。还可以在当前任务中说：

- `查看自动续跑状态`
- `关闭自动续跑`

## 实际行为

- Hook 只登记当前 Codex 任务的 `threadId` 与本次控制 `turnId`，不会复制提示词或创建第二个任务。
- 后台只把“顶层 turn 的结构化 `UsageLimitExceeded`”当成额度中断；额度显示 100%、普通报错或子代理受限都不会单独触发续跑。
- 五小时/周额度按 `windowDurationMins` 识别，不假设 `primary` 一定是五小时；所有官方额度桶都会展示，Codex 未返回的窗口会明确显示为未提供。
- 五小时与周额度同时阻塞时，等待更晚的刷新时间，再加 60 秒安全余量。
- 如果已确认额度错误、但 Codex 尚未给出刷新时间，会停在“确认刷新时间”并继续读取，绝不猜时间提前续跑。
- 工作区 credits 耗尽或没有可恢复窗口的组织用量上限，会转为“需要处理”，不会永久假装等待。
- 到点后重新读取额度，并再次确认原失败 turn 没有变化，才在同一个 thread 启动一次续跑。
- 如果用户已经从 Codex 手动继续，自动续跑会取消并显示“检测到外部操作”。
- 所有自动续跑全局串行；一个自动 turn 未结束时不会启动第二个。
- 自动 turn 必须返回 `complete / needs_input / blocked` 的严格结果；只有 `complete` 才结束目标，其他情况都会回到用户处理。
- 如果当前任务设置了 Codex `/goal`，守护会在当次进程内把目标带入续跑；目标正文与最终验证仍留在原 Codex 任务中，不写入守护状态。
- 崩溃边界无法证明是否已经提交过 `turn/start` 时会停在“需要处理”，不会用猜测换取可能的重复执行。
- 睡眠错过刷新点时，在唤醒后立即重新检查。
- 后台每 60 秒刷新一次额度；解锁和手动“立即检查”也会马上刷新。

## 本机数据与安全边界

- 状态原子写入 `~/Library/Application Support/codex-resume-manager/state.json`。
- Codex 控制命令写入同目录的 `commands/`，采用原子 claim 和失败重试。
- 命令处理后通过一次性匹配 ACK 返回真实结果；连续失败会进入隔离区，不会堵死后续命令。
- 为识别顶层额度错误、人工继续和自动续跑结果，应用会通过 Codex App Server 在内存中短暂读取线程及 turns；完整 turns、用户提示词和隐藏推理不会写入本应用状态文件。
- 状态文件只保存恢复必需的本机元数据：任务/turn 标识、项目路径、Codex 版本、目标状态、额度与恢复检查点。任务标题、目标正文、结果正文、验证文本和自由格式错误不会持久化；最多 200 条记录只使用固定状态文案。
- 界面默认隐藏项目路径和完整任务 ID，系统通知只显示泛化状态；完整 ID 仅在用户主动点击复制时进入剪贴板。
- 控制命令超过 5 分钟即拒绝处理；应用启动时和运行期间会清理超过 1 小时的确认文件、超过 7 天的失败隔离文件。
- 应用内可一键清除守护列表、记录、额度缓存与本机控制文件，不会删除 Codex 中的原任务。
- 不读取或上传 `auth.json`、Codex SQLite、rollout/JSONL、隐藏推理或完整对话。
- 认证、模型、线程和额度访问都交给 Codex App Server；本项目不接触 Codex 凭据，也不提供遥测或自有云端服务。
- 后台续跑若需要不可见的人工审批，必须安全停止并让用户回到 Codex 处理，不能静默挂住或擅自批准。

完整的数据清单、保留方式和清除方法见 [PRIVACY.md](./PRIVACY.md)。安全问题请按 [SECURITY.md](./SECURITY.md) 私下报告，不要在公开 Issue 中粘贴真实任务或诊断文件。

## 本机开发与验证

要求：macOS、Node.js 22+、已登录的 Codex CLI。应用会从 `PATH` 和常见安装位置动态查找 `codex`；如需指定其他位置，可设置 `CODEX_RESUME_MANAGER_CODEX_PATH`。

```bash
npm install
npm run check
npm start
```

例如在开发启动时显式指定 Codex CLI：

```bash
CODEX_RESUME_MANAGER_CODEX_PATH="$(command -v codex)" npm start
```

生成 unsigned arm64 应用：

```bash
npm run package:mac
```

产物位于：

```text
release/CodexResumeManager-darwin-arm64/CodexResumeManager.app
```

首版不包含签名、公证、自动更新、云端服务、购买 credits 或消费重置券。

## 验收边界

自动化测试覆盖正常观察、双额度窗口、刷新前零次续跑、刷新后一次、人工继续、崩溃幂等、多个任务串行、App Server 重连和命令投递恢复。

最终的真实验收仍需等一次自然发生的 `UsageLimitExceeded`：记录失败 turn，等待真实刷新，然后确认同一个 `threadId` 只自动启动一次并完成后续验证。

## 项目可见性与授权

本仓库默认按私有项目管理，保留全部权利。当前未授予开源许可证，插件 manifest 中的 `UNLICENSED` 是有意设置；除非权利人另行书面许可，不得复制、再分发或将本项目作为公开发行物发布。
