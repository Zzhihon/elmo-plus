# 自动化提示词

## Codex 桌面版自动化

在 Codex 桌面版中，于本仓库目录下新建一个线程（例如命名为“GEO 每周浏览器采样”），再为该线程创建自动化：每周一 09:00（Asia/Shanghai），在当前线程中执行。提示词原文如下（`/Users/bt1q/orca/elmo-plus` 换成你的仓库路径）：

<!-- prompt:start -->
```text
执行本周的 GEO 浏览器采样，在当前线程中完成，不新建聊天。

严格按照 /Users/bt1q/orca/elmo-plus/infra/geo-browser-sampler/RUNBOOK.md 执行（先完整读一遍），其中 $REPO=/Users/bt1q/orca/elmo-plus。结果写到 /Users/bt1q/orca/elmo-plus/infra/local/geo-browser-sampler/results/<planKey>/。

要点：用 geo MCP 的 geo_get_sampling_plan 取本周方案；只用 geo-chrome MCP 操作浏览器（它使用我已登录各应用的采样专用 Chrome 配置目录；不要用内置浏览器或 Chrome 扩展）；每个问题新开对话、逐字输入、等回答完成、展开引用、保存全文和截图、用 bin/append.mjs 追加一行；问题之间随机间隔 20–60 秒；不超出方案。遇到验证码、登录墙、限流或地区封锁时停止该平台并记 FAILED，绝不绕过，也不替我登录。全部平台结束后上传截图、分批导入、写 summary.md。

最后回复：每个平台的 VALID / PARTIAL / FAILED 数量、失败原因、同步结果，以及需要我手动处理的事项。不要只回复计划或倒计时；没有实际打开页面采样就不算完成。
```
<!-- prompt:end -->

对应的 `~/.codex/automations/<id>/automation.toml` 大致如下，仅供核对，建议通过桌面版界面创建（`target_thread_id` 是上面新建线程的 id）：

```toml
version = 1
id = "geo-browser-sampler"
kind = "heartbeat"
name = "GEO 每周浏览器采样"
prompt = "<上面的提示词>"
status = "ACTIVE"
rrule = "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0;BYSECOND=0"
target_thread_id = "<线程 id>"
```

## 命令行（手动或无界面运行）

同一份提示词通过 `codex exec` 运行。浏览器相关特性在 0.164 中默认开启；`network_access` 让 `sync.mjs` 回退同步可以联网：

```sh
REPO=/Users/bt1q/orca/elmo-plus
awk '/^<!-- prompt:start -->/{f=1;next} /^<!-- prompt:end -->/{f=0} f && !/^```/' \
  "$REPO/infra/geo-browser-sampler/automation-prompt.md" |
  codex exec -C "$REPO" -s workspace-write \
    -c sandbox_workspace_write.network_access=true \
    -o "$REPO/infra/local/geo-browser-sampler/last-run.txt" -
```

运行前关闭用采样专用目录打开的 Chrome 窗口（agent 会自己启动它）；你日常用的 Chrome 不受影响。
