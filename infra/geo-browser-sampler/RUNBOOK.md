# GEO 浏览器采样 Runbook

本文件是每周采样任务的执行说明，执行者是通过 `geo-chrome` MCP（chrome-devtools-mcp，固定使用采样专用 Chrome 配置目录）操控浏览器的 Codex agent。目标只有一个：**像真实买家一样**在 6 个 AI 应用里提问，原样记录买家看到的回答、引用来源和截图，再同步进 GEO 系统。

下文中 `$REPO` 指本仓库根目录（由自动化提示词给出），`$S` 指 `$REPO/infra/geo-browser-sampler`，`$OUT` 指 `$REPO/infra/local/geo-browser-sampler`（不提交到 git）。

## 0. 红线（任何时候都适用）

- **绝不绕过任何防护**：不解验证码（含滑块、点选、“我不是机器人”），不注册或切换新账号，不代替操作员登录，不切换 VPN / 代理 / 地区，不修改、导出或注入 Cookie / localStorage，不用开发者工具伪造请求。
- 遇到验证码、登录墙、限流、地区封锁：**立即停止该平台**，按第 5 节写 FAILED 行，继续下一个平台。
- 不超出方案：只问方案里的问题，每个问题最多问 `repeats` 次，不重试成功过的 runKey，不追问、不点“重新生成”、不点推荐问题。
- 问题文本必须与方案逐字一致（不加前缀、不改标点、不翻译）。
- 不改应用默认设置（深度思考、联网搜索、模型选择），除非方案的 `rules` 或该平台 `notes` 明确要求；唯一例外见 3.2 关于记忆的处理。
- 不在任何文件或回复里写账号邮箱、手机号；`session.account` 只写操作员给的标签（如 `test-1`）。
- 页面结构以**实时页面为准**。第 8 节的平台提示只是可能过时的线索。

## 1. 获取方案

1. 调用 MCP 工具 `geo_get_sampling_plan`（不传 `planKey`，取本周方案）。
2. 成功后把完整返回写入 `$OUT/results/<planKey>/plan.json`，并复制一份到 `$OUT/plan-cache.json`。
3. MCP 不可用时：读取 `$OUT/plan-cache.json`。本周 planKey 用 `TZ=Asia/Shanghai date +%G-W%V` 计算；若缓存的 planKey 不是本周，把 planKey 改成本周后再写入 `$OUT/results/<planKey>/plan.json`，并在 summary 中注明“方案来自本地缓存”。缓存里的 `completedRunKeys` 此时视为空。两者都没有时，停止并在线程中报告。

## 2. 计算待办

待办 runKey = 对方案中每个 `platform` × 每个 `question` × `n = 1..repeats`：

```
<planKey>/<platform>/<promptId>/<n>
```

跳过：
- 方案 `completedRunKeys` 中已有的；
- `$OUT/results/<planKey>/observations.jsonl` 中最后一行状态为 VALID 或 PARTIAL 的。

补采：方案 `failedRunKeys` 里的、或本地最后一行为 FAILED 的 runKey，本次重新提问一次（同一次运行内不重复补采）。重问成功后用 `bin/append.mjs` 追加新行即可，旧的 FAILED 行保留作审计，同步时以最后一行为准，服务器会用新回答替换失败记录。若失败原因仍在（例如仍要求登录），照常记 FAILED 并在 summary 里说明。

先执行 `mkdir -p $OUT/results/<planKey>/shots $OUT/results/<planKey>/tmp`。全部跳过时，直接进入第 6 节做同步和汇总。按方案中 `platforms` 的顺序逐个平台执行；平台内按问题顺序，问完所有问题的第 1 次再做第 2 次。

## 3. 每个平台

### 3.1 打开

只用 `geo-chrome` MCP 的工具操作浏览器（`new_page` / `navigate_page` 打开、`take_snapshot` 看页面结构、`fill` / `click` / `press_key` 输入和发送、`evaluate_script` 读取回答全文和引用链接、`take_screenshot` 截图）。它启动的 Chrome 使用操作员已手动登录各应用的采样专用配置目录。不要改用 Codex 内置浏览器、Chrome 扩展或其他浏览器通道。用 `new_page` 打开该平台的 `chatUrl`。

检查：
- 页面显示登录按钮 / 要求登录 → `LOGIN_REQUIRED`，停止该平台。
- 出现验证码 → `CAPTCHA`；提示“访问过于频繁 / 达到上限” → `RATE_LIMITED`；提示所在地区不可用 → `REGION_BLOCKED`。
- 记下页面显示的模型名称（如有）用于 `modelVersion`。

### 3.2 记忆与个性化

每个平台每次运行检查一次设置里的“记忆 / 个性化 / 参考历史对话”类开关：
- 已关闭：正常继续。
- 开启：允许**只把这一个开关关掉**，并在该平台每一行的 `note` 中写“已关闭记忆”；找不到开关就不要折腾，在 `note` 中写“记忆状态未确认”。

### 3.3 记录开关状态

在输入框附近查看“深度思考 / 推理”和“联网搜索”开关的当前状态，分别记入 `session.deepThinking` 和 `session.webSearch`；看不出状态时省略该字段。不要为了记录去切换它们。

## 4. 每个问题（每个 runKey）

1. **新对话**：点击“新对话 / New chat”，确认输入区为空、页面没有上一轮内容。
2. **输入**：逐字输入问题文本，按发送。记下发送时刻作为 `sampledAt`（ISO 8601，带 `+08:00`，例如 `2026-11-02T09:14:03+08:00`）。
3. **等待完成**：满足任一即视为完成——“停止生成”按钮消失且回答下方出现复制 / 点赞等操作按钮；或回答文本连续 5 秒没有变化。从发送起最长等 180 秒，超时则按第 5 节判断（有部分文本记 PARTIAL + `TIMEOUT` 说明于 note，完全没有文本记 FAILED `TIMEOUT`）。
4. **引用**：展开“参考资料 / 引用 / 搜索结果 / 来源 / Sources”等面板（含回答内角标点开后的列表），收集每条来源的 URL 和标题到 `citations`。只记应用真实展示的来源，去重，保持出现顺序。展开失败时记 PARTIAL，并在 `note` 说明。
5. **回答全文**：优先点回答下方的“复制”按钮，然后 `pbpaste > $OUT/results/<planKey>/tmp/answer.txt`；复制按钮不可用时读取回答区 DOM 文本写入同一文件。全文必须完整（包括表格、列表），不要摘要或改写。
6. **截图**：把整段对话（问题 + 完整回答 + 展开后的引用）截图保存为 `$OUT/results/<planKey>/shots/<platform>-<promptId>-<n>.png`。聊天内容常在页面内部滚动区域里，一张截不全时滚动分段截图，依次命名 `<platform>-<promptId>-<n>-a.png`、`-b.png`…，全部写进 `evidence`。用 `take_screenshot`（`fullPage: true`）保存：geo-chrome 只允许写入系统临时目录，`filePath` 要用 `$TMPDIR/geo-shots/<同名文件>`（先 `mkdir -p "$TMPDIR/geo-shots"`），保存后再 `cp` 到上述 `shots/` 路径；直接写 `shots/` 会被拒绝（Access denied … not within any of the configured workspace roots）。回答在页面内部滚动区域时，先 `evaluate_script` 把该区域滚到对应位置再分段截图。
7. **写入一行**：把除 `responseText` 以外的字段写到 `tmp/row.json`，然后执行：

   ```
   node $S/bin/append.mjs $OUT/results/<planKey> --answer-file $OUT/results/<planKey>/tmp/answer.txt < $OUT/results/<planKey>/tmp/row.json
   ```

   脚本会校验字段并拒绝重复 runKey；报错时修正字段后重试，不要手工拼接 JSONL。行格式见 `$S/schema/observation.schema.json`，示例：

   ```json
   {"runKey":"2026-W45/doubao/<promptId>/1","planKey":"2026-W45","platform":"doubao","promptId":"<promptId>","question":"<方案原文>","sampledAt":"2026-11-02T09:14:03+08:00","status":"VALID","citations":[{"url":"https://…","title":"…"}],"evidence":["shots/doubao-<promptId>-1.png"],"evidenceRefs":[],"modelVersion":"<页面显示的模型名>","session":{"account":"test-1","loggedIn":true,"deepThinking":false,"webSearch":true,"region":"CN"}}
   ```

   `session.account` 和 `session.region` 取自 `$OUT/accounts.md`（操作员维护的“平台 → 账号标签 → 网络地区”），没有该文件或不确定时省略 account、region 写 `unknown`。

8. **间隔**：两次提问之间随机等待 20–60 秒（例如 `sleep $((20 + RANDOM % 41))`）。

### 状态判定

| 状态 | 条件 |
|---|---|
| VALID | 回答完整生成，全文已保存，截图已保存，引用面板（如有）已收集 |
| PARTIAL | 有回答文本，但缺了某部分：超时截断、引用没能展开、截图不全等；`note` 写清缺什么 |
| FAILED | 没有可用回答；必须带 `failure.code` 和 `failure.message` |

回答为空或只有“无法回答”的系统报错 → FAILED `EMPTY_ANSWER`。按钮或输入框找不到、页面结构变化导致无法操作 → FAILED `UI_CHANGED`。其他 → `OTHER`。注意：模型**正常回答但没有提到客户品牌**是有效结果，记 VALID。

## 5. 平台级失败

在任何时刻遇到 `CAPTCHA`、`LOGIN_REQUIRED`、`RATE_LIMITED`、`REGION_BLOCKED`：

1. 不做任何绕过尝试，不刷新重试。
2. 当前问题写 FAILED 行，`failure.message` 描述看到的内容（如“出现滑块验证码”）；能截图就截图放进 `evidence`。
3. 该平台**剩余所有待办 runKey** 都写 FAILED 行，同一个 code，`message` 写“平台已因 <code> 停止”，`evidence` 为空。
4. 关闭该平台标签页，继续下一个平台。

连续 3 个问题 `UI_CHANGED` 或 `TIMEOUT` 时，同样停止该平台并把剩余待办写成同 code 的 FAILED 行。

## 6. 同步

所有平台结束后：

1. 运行 `node $S/bin/validate.mjs $OUT/results/<planKey>`，有错误先修正（不要删除真实的 FAILED 行）。
2. 对每个 `evidenceRefs` 数量少于 `evidence` 的行，逐个读取截图、base64 编码，调用 `geo_upload_evidence({ fileName, contentType, contentBase64 })`，把返回的 `evidenceRef` 按 `evidence` 的顺序写回该行的 `evidenceRefs`（整文件重写，保持其他字段不变）。
3. 按每批不超过 50 行调用 `geo_import_browser_observations({ planKey, rows })`，累计 `created / skipped / failedRecorded / errors`。服务端按 runKey 去重，重复导入是安全的。
4. MCP 调用失败或截图太大无法通过工具传递时，改用 `node $S/bin/sync.mjs $OUT/results/<planKey>`（需要 README 中的 `GEO_MCP_URL` 和 `GEO_MCP_KEY_FILE`）；也失败时保留文件，在报告中写明“待手动同步”。

## 7. 汇总与报告

写 `$OUT/results/<planKey>/summary.md`：

- 本次运行时间、planKey、方案来源（MCP / 本地缓存）；
- `validate.mjs` 输出的分平台表格（VALID / PARTIAL / FAILED 数量及失败码）；
- 同步结果（created / skipped / failedRecorded 以及每条 error）；
- 异常与观察：记忆开关被关闭、模型名称变化、页面改版、某平台持续限流、回答明显异常等。

最后在线程中用几行汇报：每个平台的完成情况、失败原因、是否已同步、需要操作员处理的事（例如重新登录某平台）。不要贴回答全文。

## 8. 平台提示（尽力而为，可能已过时，以实时页面为准）

- **豆包 doubao**：左侧栏顶部有“新对话”。默认可能开启联网搜索；引用常以回答末尾的“参考 N 篇资料”或角标呈现，点开后是来源列表。深度思考按钮在输入框下方。
- **DeepSeek**：左侧栏“开启新对话”。输入框下方有“深度思考”和“联网搜索”两个开关，状态会跨对话保留。联网时回答上方显示“已搜索到 N 个网页”，点开是来源列表；回答内有数字角标。没有记忆功能。高峰期常出现“服务器繁忙”——记 FAILED `RATE_LIMITED`，不要重试。
- **通义千问 qwen**：左上角“新建对话”。联网引用通常在回答顶部或底部的“搜索来源 / 参考资料”折叠区。可能出现滑块验证码。
- **腾讯元宝 yuanbao**：左侧“新建对话”。可选模型（如混元 / DeepSeek），只记录不切换；联网搜索结果以“参考 N 篇资料”展示，点开为来源列表，部分来源是公众号文章。
- **ChatGPT**：左上角铅笔图标“New chat”。设置 → 个性化 中有“记忆 / 参考聊天记录”。搜索结果以回答内的来源胶囊和底部“Sources”按钮呈现，点开侧栏列出全部来源。中国大陆网络下可能不可用 → `REGION_BLOCKED`。
- **Gemini**：左上角“发起新对话”。引用常以回答下方的“来源”或段落末尾的小图标显示；“Gemini 应用活动记录 / 已保存的信息”属于个性化设置。可能出现“我不是机器人”验证 → `CAPTCHA`。
