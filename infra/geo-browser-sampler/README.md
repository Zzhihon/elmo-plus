# GEO 浏览器采样

每周由 Codex agent 驱动操作员已登录的真实 Chrome，在 6 个 AI 应用（豆包、DeepSeek、通义千问、腾讯元宝、ChatGPT、Gemini）里逐字提问方案中的买家问题，记录买家真实看到的回答全文、引用来源和截图，再通过 GEO 系统的 MCP 接口导入，用于衡量这些应用是否提及、推荐客户品牌。

| 文件 | 用途 |
|---|---|
| `RUNBOOK.md` | agent 每次执行遵循的步骤 |
| `automation-prompt.md` | 粘贴到 Codex 自动化的提示词，以及 `codex exec` 命令 |
| `schema/observation.schema.json` | 结果文件中每一行的格式 |
| `bin/append.mjs` | agent 追加一行结果（校验 + 防重复） |
| `bin/validate.mjs` | 校验一周的结果目录并输出分平台统计 |
| `bin/sync.mjs` | MCP 工具不可用时的回退同步 |

脚本只依赖 Node 24，无需安装依赖。

## 一次性准备

### 1. Chrome 与账号

采样不用你日常的 Chrome，也不用 Codex 的 Chrome 扩展（扩展每个会话都要人工批准，无人值守时会被拒绝）。agent 通过 `chrome-devtools-mcp` 启动一个使用专用配置目录的 Chrome，登录态保存在这个目录里。

1. 在 `~/.codex/config.toml` 加入：

   ```toml
   [mcp_servers.geo-chrome]
   command = "npx"
   args = ["-y", "chrome-devtools-mcp@1.12.0", "--userDataDir", "/Users/<你>/.local/share/geo-sampler-chrome", "--viewport", "1440x1000", "--usageStatistics", "false", "--performanceCrux", "false"]
   startup_timeout_sec = 60.0
   ```
2. 用同一个目录打开一个 Chrome 窗口：`open -na "Google Chrome" --args --user-data-dir="$HOME/.local/share/geo-sampler-chrome"`。这个配置目录只用于采样，不登录私人账号。
3. 在这个窗口里**由操作员手动登录**以下 6 个应用，使用专用测试账号。agent 永远不会替你登录、注册或处理验证码：
   - 豆包 https://www.doubao.com/chat/
   - DeepSeek https://chat.deepseek.com/
   - 通义千问 https://www.qianwen.com/
   - 腾讯元宝 https://yuanbao.tencent.com/chat
   - ChatGPT https://chatgpt.com/
   - Gemini https://gemini.google.com/app
4. 在每个应用的设置里关闭记忆 / 个性化 / 参考历史对话；深度思考和联网搜索保持应用默认（除非方案另有要求）。
5. 给每个账号起一个标签（如 `test-1`），在 `infra/local/geo-browser-sampler/accounts.md` 里记下“平台 → 标签 → 网络地区（如 CN）”，agent 写 `session.account` / `session.region` 时只用标签。该目录不提交。
6. 登录完成后**关闭这个 Chrome 窗口**：同一目录同一时间只能被一个 Chrome 使用，不关的话 agent 启动浏览器会失败。
7. 登录态会过期。summary 中出现 `LOGIN_REQUIRED` 时，用第 2 步的命令打开窗口重新登录，再关掉。

ChatGPT 和 Gemini 在部分网络环境下不可用；agent 不会切换网络，只会记 `REGION_BLOCKED`。网络环境由操作员事先决定并保持每周一致。

### 2. API key 与 Codex MCP 配置

1. 在 GEO 系统中创建一个 API key（需要采样方案读取和导入权限），保存到只有自己可读的文件：

   ```sh
   mkdir -p ~/.config/geo && umask 077 && pbpaste > ~/.config/geo/mcp-key
   ```

2. 在 `~/.codex/config.toml` 中加入（或运行 `codex mcp add geo --url <地址> --bearer-token-env-var GEO_MCP_KEY`，生成的配置相同）：

   ```toml
   [mcp_servers.geo]
   url = "https://<GEO 系统域名>/api/mcp"
   bearer_token_env_var = "GEO_MCP_KEY"
   ```

   本地开发时地址为 `http://localhost:3000/api/mcp`。

3. 让 Codex 进程能读到 `GEO_MCP_KEY`：
   - 命令行：在 `~/.zshrc` 中 `export GEO_MCP_KEY="$(cat ~/.config/geo/mcp-key)"`。
   - 桌面版（从 Dock 启动，不读 `~/.zshrc`）：`launchctl setenv GEO_MCP_KEY "$(cat ~/.config/geo/mcp-key)"` 后重启 Codex；重启电脑后需重新执行，可以把这条命令放进一个登录时运行的 LaunchAgent。
   - 运行 `codex mcp list` 确认 `geo` 已配置；在线程里让 agent 调用一次 `geo_get_sampling_plan` 确认连通。

### 3. 创建自动化

按 `automation-prompt.md` 操作：在 Codex 桌面版中于本仓库目录下新建线程，再为该线程创建每周一 09:00（Asia/Shanghai）的自动化，粘贴提示词。首次建议先手动在该线程发送一遍提示词，观察完整一轮。

## 结果在哪里

```
infra/local/geo-browser-sampler/          # 已在 .gitignore 中
  plan-cache.json                         # 最近一次取到的方案，MCP 不可用时使用
  results/<planKey>/                      # planKey 形如 2026-W45（ISO 周，Asia/Shanghai）
    plan.json                             # 本周方案
    observations.jsonl                    # 每行一次提问
    shots/<platform>-<promptId>-<n>.png   # 截图
    summary.md                            # 本周汇总
    sync-result.json                      # sync.mjs 的结果
```

## 手动校验与同步

```sh
DIR=infra/local/geo-browser-sampler/results/2026-W45

node infra/geo-browser-sampler/bin/validate.mjs "$DIR"

GEO_MCP_URL=https://<GEO 系统域名> GEO_MCP_KEY_FILE=~/.config/geo/mcp-key \
  node infra/geo-browser-sampler/bin/sync.mjs "$DIR" --dry-run    # 去掉 --dry-run 正式同步
```

`validate.mjs` 检查格式、runKey 唯一、VALID / PARTIAL 的截图存在、`sampledAt` 落在该 ISO 周内，以及（有 `plan.json` 时）平台和问题是否属于方案；有错误时退出码非 0。

`sync.mjs` 上传尚无 `evidenceRefs` 的截图并把 ref 写回 `observations.jsonl`，再按每批 50 行导入。服务端按 runKey 去重，重复运行是安全的。`GEO_MCP_URL` 可以是站点根地址或完整的 `/api/mcp` 地址。

中断后可以在同一周内重新运行自动化或命令行：已记录的 runKey 会被跳过。

## 波动与重复

同一问题在同一应用里每次回答都可能不同（模型采样、联网结果、A/B 实验）。因此：

- 方案的 `repeats` 决定每个问题在每个平台问几次，每次都是新对话；
- GEO 系统把结果看作**比率**（例如“10 次中提及客户品牌 6 次”），而不是某一次回答的结论；
- 单周样本小，趋势要跨多周看；FAILED 行表示没有采到回答，不等于“没有提及”，它反映的是覆盖率。

## 合规说明

- 频率低：每周一次，问题之间间隔 20–60 秒，不超出方案的问题数和次数。
- 使用专用测试账号，不使用私人或客户账号。
- 不绕过任何防护：不解验证码、不注册新账号、不切换 VPN、不改 Cookie。遇到即停止该平台并记录。
- 各应用的用户条款可能禁止自动化访问。是否启用本流程、对哪些平台启用，由操作员自行判断并承担责任；可以通过让方案不包含某平台来停用它。
- 结果文件只保存在本机 `infra/local/`，不要提交到 git。
