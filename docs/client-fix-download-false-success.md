# 客户端修复说明：下载“假完成”——把 Subsonic 错误响应误记为成功

> 配套文档：服务端交接单 `server-handoff-lxserver.md`；技术方案 `plans/fix-download-false-success.md`。
> 背景：某歌单在 lxserver 上“显示 300 首全部下载完成”，实际约 40% 文件是 220 字节的错误 JSON。

---

## 一、问题现象

1. 下载歌单后界面显示“全部完成”，但离线播放列表里点进去，过一段时间又变成“已加入待播清单”，显示只下载了 275 of 300。
2. 文件管理器里查那批歌，实际文件是 220 字节的 JSON 错误体，不是音频。

## 二、根因（客户端侧）

**下载“成功”的判定只看 HTTP 状态码和“读到 EOF”，完全不看内容。**

底层下载器（`modules/expo-async-fs/android/.../ExpoAsyncFsModule.kt`）只在「非 2xx / 抛异常 / body 为 null」时才报错，没有校验 Content-Type、最小字节数，也没探测音频头。**`downloadSong` 连 `bytes === 0` 都没拒绝**（对比 `redownloadTrack` 有 `if (bytes === 0) return false`）。

而 lxserver 在取不到音源时，按 Subsonic 规范用 **HTTP 200 + `subsonic-response status="failed"` 的 JSON 错误体**表达失败。于是这 220 字节错误体被写成 `<songId>.mp3`，计入成功、写入 `cached_songs`、补一条边，整张歌单被判定完成并 finalize —— 这就是“最初显示 300 首全完成”。

**第二处放大问题：预扫描只查内存池，不验磁盘。**

`musicCacheService.ts:1304-1310`（预扫描）和 `:1435-1437`（`downloadSong` 的提前返回）只判断 `cachedSongs[id]` 存在就算已下载，**不打开文件、不校验内容**。所以：
- 凡是“别处已下过”的曲目，只补边、不下载、也不校验文件；
- 已被写坏的 220 字节文件永远不会被重新下载，也永远显示“已下载”。

**为什么之后变 275：** 后台库同步重新拉取整张歌单并重下（见历史分析）。失败集合每次都飘（113↔135，交集仅 61），某一轮真失败（非 2xx/超时/断流）的数量自然变化，275 就是其中一轮的数字。

---

## 三、修复方案（纯 TS 改动，不动原生层）

新增 `src/services/downloadResponseGuard.ts`，在下载落盘前校验响应是否为可用音频：

1. **读文件头判定**：用 expo-file-system 的 `File.open(FileMode.ReadOnly)` + `FileHandle.readBytes(n)` 读前 64 字节（无需新原生接口）。
2. **规则**：跳过 BOM/空白后，首字节是 `{`(0x7B) 或 `<`(0x3C)（或文件为空）→ 判定为“文本错误文档”（Subsonic 错误信封 JSON 以 `{` 开头、XML 以 `<` 开头，HTML 错误页同理）；任何音频容器（mp3=`ID3`/0xFF、flac=`fLaC`、ogg=`OggS`、m4a=`ftyp`、wav=`RIFF` 等）首字节都不可能是这两者。
   - 故意**不**要求 `audio/*` 白名单：服务器以 `application/octet-stream` 流式返回时必须仍算成功。
   - 纯字节比较，不用 `TextDecoder`（Hermes 下不保证可用，且仓库无此用法）。
3. **两个方向（关键，不能合并）**：
   - 下载路径（`downloadSong`、`redownloadTrack`）：**失败开放**——只有“拿到文本的正证据”才拒绝；读不到头就按现状接受，否则某设备不支持 `File.open` 会全盘拒下。
   - 缓存状态判断（预扫描、`enqueueSongDownload`）：**失败保守**——读不到/不存在即“未缓存”，触发重下。
4. **`downloadSong` 落盘前校验**：用下载返回值判空（不是移动后的 `dest.size`），命中文本文档就删临时文件、`return null`。临时文件删除必须显式（现有清理只在 `catch` 里）。
5. **预扫描与 `downloadSong` 的“已在缓存池”判断改为验盘**：用 `CachedSongMeta` 解析路径（不能用队列 `Child`，转码时后缀不同会算错路径）。加 `myId !== processingId` 提前退出，避免被取消时卡在大量小读取。
6. **另外两个入口也加守卫**：`enqueueSongDownload`（单曲下载）、`redownloadTrack`（缓存浏览器重下，现在会用 220 字节错误体**覆盖掉一个好文件**）。

---

## 四、覆盖范围与限制

**覆盖**：item 下载、单曲下载、缓存浏览器重下三条会把“已下载”记入的入口。

**限制（已接受，非本次改动范围）**：

1. **不主动清理改动前已写坏的 220 字节文件**：这些文件的 `cached_songs` 行还在，`useDownloadStatus` 仍报“已下载”，播放器仍尝试播它。它们会在“下次重下该歌”时被自愈（预扫描验盘发现不可用 → 替换），但不会被主动扫描清除。彻底清理需另开方案（涉及 `deleteCachedSong` 的级联边，影响面需单独评估）。
2. **非文本、非音频的 200 响应**（二进制垃圾）仍会被接受 —— 目前无观测案例，识别需音频嗅探，留作下一步。
3. **专辑补下、封面缓存**等同类型问题本次未动；封面缓存有同类 bug，另行处理。

---

## 五、验证方式

- `npm install`（此 checkout 未装依赖）→ 确认 `File.open`/`FileHandle.readBytes` 签名 → `npx jest src/services/__tests__/downloadResponseGuard.test.ts` → `npx jest` 全量。
- `npm run local-ci` 会按 CI 跑校验脚本 + `npx tsc --noEmit`（无 eslint 步骤，类型错误靠 tsc 抓）+ 全量 jest。
- 真机端到端本机无法跑（无 adb/模拟器），需在你设备上确认：下载该歌单停止在实际可服务的曲目数、失败可重试、已写坏的 220 字节文件在重下时被替换。

---

## 六、与服务端的关系

服务端修复（`server-handoff-lxserver.md`）是“让失败真的返回 4xx/5xx + 提高取链成功率”，能减少失败数量；**但客户端这层校验是必须的**——任何用 200 表达失败的 Subsonic 服务器（规范允许）都会复现“假完成”。两端正交，互不替代。
