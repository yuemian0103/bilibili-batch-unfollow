# B站批量取关

一个 Tampermonkey / Violentmonkey 用户脚本：扫描你关注的全部 UP 主，按「最新动态是否早于一年」判定不活跃，再结合投稿/动态里的视频情况，分三种口径批量取关。

当前版本：**v2.2.5** ｜ 运行页面：`www.bilibili.com/*`、`space.bilibili.com/*`

## ⚠️ 先用五分钟读这一段

批量取关是**不可逆**操作，而这份脚本的判定是「失败偏向删除」的：

- 投稿页请求异常时，日志会写「降级为API验证」，但代码**实际直接返回 false**（没有降级），该 UP 会因此被判成「无视频」；
- 视频列表接口没有做 wbi 签名适配，被风控拒绝时直接 break，同样落到「无视频」；
- 除 `-352 / -412 / -403 / -401` 之外的异常码，会让动态接口返回空，从而被判成「无动态」。

也就是说：**接口抖一下，就可能有账号被算进取关名单**。整个流程只在执行前弹一次 `confirm`（整批一次，不是逐批），没有预览名单、没有 dry-run、没有总数上限。

建议的安全用法：先只跑「扫描」和「导出 TXT」，人工核对名单后再点取关；第一次只用最小的一个按钮、盯住日志。作者不对任何误取关负责。

## 工作流程

1. **① 扫描**：`/x/web-interface/nav` 取当前登录 mid → `/x/relation/followings` 以每页 50 条拉全部关注 → 8 并发扫描每个 UP：取最新动态时间，早于 365 天即记为不活跃，同时跑视频检测并存下 `hasVideo`。支持断点续扫（状态写 localStorage）。
2. **② 复核**：对首轮「无动态」的 UP 再查一次动态，结果单独存 `gNoDynFinal`。
3. **③ 取关「无动态」**：复核后无动态 **且** 无视频。
4. **④ 取关「不活跃」**：最新动态早于 365 天 **且** 无视频。
5. **⑤ 取关「不活跃+有视频」**：最新动态早于 365 天 **且有视频** —— 风险最高的一档，等于按「一年没动静」删除仍有作品的 UP。

另有「导出 TXT」（含 UP 名、mid、空间地址、最后动态时间）、「暂停」、「重置」。

## 判定与视频检测

- `INACTIVE_DAYS = 365`：`最新动态时间 < now - 365d` 即不活跃。
- 视频检测名义上有三重：
  1. 投稿页 DOM：请求 `space.bilibili.com/<mid>/upload/video`，正则找 `video-list-item` / `bili-video-card`，同时排除「暂无投稿」等文案；
  2. 视频列表接口：`/x/space/arc/search` 多页，只看一年内稿件；
  3. 动态里的 `archive`/`video` 模块。
- 三者只要有一条给出「有视频」就算有；但上面说过，**异常路径会返回 false 而不是「未知」**。

## 接口

| 端点 | 用途 |
| --- | --- |
| `/x/web-interface/nav` | 取登录用户 mid |
| `/x/relation/followings?vmid&pn&ps=50` | 关注列表分页 |
| `/x/space/arc/search?mid&pn&ps=30&order=pubdate` | 投稿视频多页检测 |
| `/x/polymer/web-dynamic/v1/feed/space` | 最新动态时间、动态里的视频模块 |
| `/x/relation/modify`（POST `fid&act=2&re_src=11&csrf`） | 取关 |

CSRF 运行时读取，依次尝试 `__BiliUser__.csrf`、`__INITIAL_STATE__.login.csrf`、`window.__BILI_USER__`、最后从 `document.cookie` 的 `bili_jct` 取；取不到直接抛 `NO_CSRF` 不执行。代码里**没有**任何明文 cookie / token / 账号信息。

## 节流与安全阀

| 参数 | 值 | 说明 |
| --- | --- | --- |
| `CONCURRENCY` | 8 | 扫描并发 |
| `PAGE_SIZE` | 50 | 关注列表每页 |
| 扫描间隔 | 400~1200ms | 每个 UP 一次随机停顿 |
| 取关间隔 | 1800~4200ms | 单条随机停顿 |
| `UNFOLLOW_BATCH_SIZE` | 5 | 每批取关数量 |
| 批间隔 | 60~120s | 批次之间停下 |
| 失败重试 | 3 次，3~8s | 单条取关失败 |

- **自动暂停**：动态接口返回 `-352/-412/-403/-401` 或非 JSON 时，暂停 5 分钟再自动恢复；同一 UP 连续 3 次被挡则进 `gBlockedList`。
- **取关侧风控**：遇到 `412/-403/403` 判定为 WAF，全局暂停并中断。
- 所有状态存 localStorage，前缀 `bili_unf_`：`allFollowings`、`taskQueue`、`scannedUids`、`inactiveList`、`nodynFirst`、`nodynFinal`、`paused`、`streak`、`blockedList`。

## 已知问题

- **`NO_DYNAMIC_THRESHOLD = 20` 与 `AUTO_RECHECK` 是死代码**：前者只在 UI 里显示 `0/20`，计数器除了重置为 0 从不自增；后者声明后从未被引用。脚本描述里的「无动态精准判定 / 自动复核」与实现不符。
- **投稿页异常不降级**：`catch` 里写「降级为API验证」，实际 `return false`。
- **动态分页用 `pn`**：该接口实际是 `offset` 游标，若每页都回 20 条且没有视频模块，循环可能不终止。
- **`@connect` 与请求不符**：只声明了 `api.bilibili.com`，但投稿页扫描请求 `space.bilibili.com`，在 `www.bilibili.com` 上属未声明跨域，容易被拦（拦了又返回 false）。
- **重置按钮会清空整个 bilibili 域**：用的是 `localStorage.clear()`，不只是脚本自己的 `bili_unf_*` 键。
- **手动设置 `Referer` 头无效**：浏览器会忽略，属残留代码。
- **⑤ 的判定口径与 ③④ 不一致**：「有视频」在 ⑤ 里指一年内新稿，而在投稿页/动态两路里只要求存在视频，三处结论可能互相矛盾。
- 整批只弹一次确认，暂停状态下会直接拒绝执行（这点是有保护的）。

## 隐私

- 只向 `api.bilibili.com` / `space.bilibili.com` 发请求，不发往任何第三方。
- 关注列表（mid + 昵称）与扫描结果保存在本机 localStorage，不上传。
- 不含硬编码凭据；`@namespace` 指向作者页。

## 许可

[MIT](./LICENSE)
