# lxserver 服务端问题交接单（Substreamer 客户端下载“假完成”）

> 来源：本机实测（Substreamer 客户端侧探针 `probe-subsonic.mjs`，报告 `probe-report-norange.json`）。
> 背景：Substreamer 客户端某歌单在 lxserver 上“显示 300 首全部下载完成”，实际约 40% 文件是 220 字节的错误 JSON。
> 客户端侧修复见 `plans/fix-download-false-success.md`（已独立处理，本单只列**服务端**要改的）。

---

## 【P0】`stream.view` 用 HTTP 200 表达失败，导致只看状态码的客户端误判下载成功

**实测现象**

对「榜单·热歌榜」(id `lb_tx_26`) 300 首逐一请求（普通 GET，不带 Range，即 App 真实请求形态）：

- 0 个非 2xx；
- **113/300 返回 `HTTP 200` + `Content-Type: application/json; charset=utf-8` + 220 字节**，正文为：

```json
{"subsonic-response":{"status":"failed","version":"1.16.1","type":"lxserver",
 "serverVersion":"1.0.0","openSubsonic":true,
 "error":{"code":0,"message":"Could not resolve music URL (all quality/source candidates failed)"}}}
```

**为什么是服务端的事**

- Subsonic 规范没有给 `stream` 端点规定 HTTP 状态码，失败本就靠 `subsonic-response status="failed"` + Content-Type 区分，返回 200 不算违反规范。
- 但几乎所有客户端的二进制下载器只看 `response.isSuccessful()`（HTTP 2xx）。200 + 错误体会被当成成功写入磁盘 —— 这就是“歌单显示全下完、实际约 40% 是 220 字节错误文件”的根因。

**建议改动**

- 二进制端点（`/rest/stream`、`/rest/download`）在 `status=failed` 时尽量返回 **4xx/5xx**（取链失败建议 502 或 404），让状态码本身表达失败，不再依赖客户端解析响应体。
- 若仍返回 200，错误文档的 Content-Type 必须按规范以 `text/xml`（或 `text/*`）开头；当前 `f=json` 返回 `application/json`，客户端更难区分。

---

## 【P0】“Could not resolve music URL” 是间歇性失败，根因在取链成功率

**实测现象**

- 两轮探测失败集合不一致：第一轮 113/300 失败，第二轮 135/300 失败，**两轮共同失败的仅 61 首**。
- 取两条“两轮都失败”的曲目单独重试，**立刻正常返回 28MB / 21MB 的 flac 音频**。
- 失败 message 恒为 `Could not resolve music URL (all quality/source candidates failed)`。

**结论**

- 不是曲目不可用，是**上游音源 URL 解析间歇性失败**（并发 / 上游限流 / 缓存未命中一类）。
- 客户端修好判定后，这些歌会如实显示“下载失败 / 待重试”，但歌单要真能下全，得服务端把取链成功率提上去。
- 这同时也是用户看到“一会儿 300 全完成、一会儿 275”的直接服务端原因（失败集合每次漂移）。

**建议改动**

- 音源解析层加退避重试 + 失败缓存；降低并发取链数；对偶发性失败不要直接回 200+error，重试成功后再回包。

---

## 【P1】`getPlaylist` 的 `songCount` 返回 0，与 `entry` 实际条数不一致

**实测现象**

- 歌单列表 / `getPlaylists` 里该歌单 `songCount = 0`；
- 但 `getPlaylist?id=lb_tx_26` 连续 3 次都返回 **300 条 entry、300 个不同 id、id 集合完全一致**（列表本身稳定，非被截断）。

**影响**

- 客户端用 `songCount` 做变更检测与界面计数（见 `normalizedLibrarySync.ts`）。`songCount=0` 与标记不符，导致界面曲目数显示错、变更检测长期失配。

**建议改动**

- 修正 `songCount` 字段，使其等于实际 `entry` 条数（300）；排查歌单聚合 / 计数逻辑里为何对该歌单算出 0。

---

## 交接备注

1. 以上三件与客户端修复**正交**：客户端修复负责“不再把 200+错误体当成功、坏文件能自愈重下”；但**服务端不改的话，用户看到的仍是大量歌曲下载失败、需反复重试**，体验问题未根本解决。
2. 证据可随交接附上：`probe-report-norange.json`（全 300 首逐首的 HTTP 状态、Content-Type、字节数、错误体原文）。
3. 涉及 lxserver 的具体代码位置（取链 resolver、stream 错误返回、playlist 计数）需到 lxserver 仓库侧定位；Substreamer 客户端仓库无 lxserver 源码。
