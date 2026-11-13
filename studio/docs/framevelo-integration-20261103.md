# FrameVelo 修复与可选后端接入（2026-11-03）

## 交付状态

已接入本地源码并在隔离桌面开发实例完成真实导出。**默认仍为 Electron；原生剪辑器和原生导出未改动。** 随后已更新 `/Applications/FantayDesign.app` 并完成安装版验收，见 [本机更新记录](framevelo-desktop-update-20261103.md)。未提交、推送或对外发布。

HTML 动效导出可选择“标准导出”或“FrameVelo 动效加速”。选择只作用于导出，不改项目内容、历史或审批状态。含实拍视频的组成、缺少工具、资源不可读，以及输出时间戳/尺寸/色彩校验失败时回退到原有路径。实际后端记录在产物 `providerNote` 和影片渲染记录 `rendererNote` 中。

CLI 与 UI 共用同一 API：

```sh
od movie render-preview --project <project-id> --html-renderer framevelo
od movie render --project <project-id> --html-renderer framevelo
od media generate --project <project-id> --surface video --model hyperframes-html --composition-dir <relative-path> --html-renderer framevelo
```

省略参数或传 `electron` 保留默认。`movie_action` MCP schema 同步公开 `htmlRenderer`。外部 CLI 通过现有工具路径发现机制查找；可用 `FANTAY_FRAMEVELO_BIN` 明确指定。渲染中不自动安装软件。

## 根因与修复

| 问题 | 定位结果 | 修复和证据 |
|---|---|---|
| 导出色彩与原页面不同 | Electron CDP PNG 使用显示器 ICC；旧编码直接把存储 RGB 当 sRGB，忽略配置文件 | `frame-color.ts` 用嵌入 ICC 转换到 sRGB，再写帧。校准红色色块存储值 `(234,51,35)` 正确转换为 `(255,0,0)`；灰阶、原色、肤色一起校准 |
| 输出帧 101 取到源帧 100 | 旧 HyperFrames 原生视频同步直接设精确边界时刻，未登记原生 `seeked`；微秒量化可落在前帧内。FrameVelo 原有额外 100µs 定位刚好避开它 | 仅在 motion-video 导出时给**视频源时间**加 100µs，并等待元数据、`seeked`、最终 paint；不偏移 GSAP 或音频时钟。烧录帧号模板匹配确认两侧 **180/180** 帧均对应正确源帧 |
| FrameVelo 原版视频时长错误 | FFmpeg 9 的时基处理与原版 `setts time_base` 组合不兼容；只查容器时长会被正常音频遮住 | 延续上一轮时基内计算时间戳补丁，增加独立视频轨时长校验；30fps 与 30000/1001 的真实输出均验证 |
| 截图回退的附加有损步骤 | 上游 screenshot fallback 使用 JPEG 95，而基线为 PNG | 本地 FrameVelo 改为 PNG 回退，避免二次图片编码损失 |
| transfer 标记与像素含义不一致 | 上游把编码器报告的 sRGB transfer 只改标为 BT.709，没有转换像素 | 保留编码器报告的 transfer，使码流与容器一致。旧路径明确 RGB→BT.709 矩阵、有限范围、sRGB transfer；不假装执行 gamma 转换 |

FrameVelo 安装版本为 `0.6.0-fantay.2`，上游仍固定 `606f2f163c2041cd04a27338ecaf35def869bdb5`。保留 `.1` 作为回退；`.2` 的 `FANTAY-PATCH.diff` 和 `fantay-install.json` 记录完整本地差异。上游单元/MCP 测试 76/76 通过。

## 复测口径：把色差、字体边缘与编码损失分开

上一轮把 Electron 146 的 PNG 与 Chrome 154 的视频整体比，混入了不同浏览器的文字边缘栅格化差异。新的分层校验不再把它笼统归为“色差”：

- 24 个已知 RGB 色块分别通过 DOM 和 Canvas 路径，以 50Mbps 静态校准排除编码噪声。FrameVelo 解码到 RGB 后色块内部平均绝对通道误差为 **0.35/255**；矩阵与范围错误的对照分支明显偏离。不存在同量级的系统性色偏；该校准不用于性能跑分。
- 字幕在同一个 Chrome 里的普通 PNG 与 `drawElementImage` 编码前 PNG **像素完全一致**。Electron 与 Chrome 的差异集中在字缘：该帧平均绝对通道差只有 0.153/255，超过 10 的像素约占 0.15%。文案和时序不变；这不等于承诺跨 Chromium 版本逐像素相同。
- 以同版本 Chrome 的逐帧无损 PNG 为参考，完整检验捕获和编码。纸雕 480 帧：**全片 PSNR 44.80 dB，最低 41.63 dB**；字幕 291 帧：**全片 46.58 dB，最低 44.62 dB**。全片 PSNR 由所有帧 MSE 计算，另保留逐帧最差值。
- 旧路径修复后，切片样例输出的烧录源帧号与 FrameVelo 一致，**180/180 无偏帧**。主时间线仍使用原秒数；100µs 仅用于视频解码边界定位。
- 三组有声样例解码为 48kHz 双声道后逐采样一致，最大绝对误差和 RMSE 都为 0；视频帧数、视频轨时长与音频轨时长一致。

初评文件 [framevelo-evaluation-20261103.md](framevelo-evaluation-20261103.md) 保留原始失败事实；本记录更新其“暂缓接入”结论。

## 性能与准入范围

下表为修复后的相同工程、相同 1080p/30fps、8Mbps 目标码率、串行单次完整运行。基线包含正确 ICC 转换，不与旧版未校色的耗时混成一个中位数；不是跨设备承诺。

| 样例 | Electron → FrameVelo | CPU 秒 | 峰值进程树 RSS MB | 准入 |
|---|---:|---:|---:|---|
| 纸雕动效，16 秒 | 55.98 → 18.63 秒 | 114.11 → 20.42 | 2236 → 1415 | 约快 3.0 倍，开放可选后端 |
| 字幕隔离，9.7 秒 | 15.66 → 10.39 秒 | 14.76 → 2.58 | 1368 → 642 | 约快 1.5 倍；该样例由现有工程派生，保留原字幕/音轨 |
| 花园实拍，9.7 秒 | 47.95 → 64.10 秒 | 75.54 → 63.21 | 2312 → 2185 | 不准入；自动使用标准路径 |
| 切片实拍，6 秒 | 17.51 → 23.73 秒 | 21.92 → 19.46 | 1476 → 1048 | 不准入；自动使用标准路径 |

目标码率相同不代表文件大小相同。正式调用沿用 FrameVelo 质量默认值，可能生成更大的文件。收益主要适用于 HTML/SVG 动效与字幕图形，不替换原生 AVFoundation/Metal 工作流。

## 功能与回归验证

- daemon 聚焦测试 35 项通过：默认路径、加速失败回退、素材路径、时钟、视频轨校验、CLI 转发等。
- Web 聚焦测试 17 项通过：默认标准导出、显式选择 FrameVelo 后请求传值、原生工作区不出现该选择器。
- desktop 聚焦测试 6 项通过，包括色彩回归和加载新编译模块的真实 Electron/WebGL 逐帧捕获。
- 根级 `guard`、全部 workspace `typecheck` 通过。
- 真实 `generateMedia` 导出了 480 帧纸雕和 291 帧有声字幕，实际 `providerNote` 均为 `hyperframes/framevelo`；未触发回退。
- 隔离桌面实例中先看到默认“标准导出”，再选择“FrameVelo 动效加速”并点击导出，最终显示“下载 MP4”。后台持久记录确认实际使用 FrameVelo。测试数据遵循 [AGENTS.md 的 daemon data directory contract](../AGENTS.md#daemon-data-directory-contract)。
- 工程原件未改写，测试使用副本。没有调用付费模型。

## 证据位置

`.tmp/framevelo-followup/` 保存色块、编码前 PNG、逐帧参考、烧录帧号匹配结果、完整 MP4 与原始测量：

- `calibrate-{dom,canvas}.json`、`calibrate-electron*.png`
- `frame-indices.json`：两侧 180 帧与源片模板的匹配
- `same-browser-qa.json`、`fixtures/*/chrome-psnr.log`
- `measurements.json`：仅 round 3 为完整受控运行；round 1/2 为修复测试工具加载和生命周期问题的无效尝试，不计入性能结果
- `runtime/{paper,captions}-result.json`：真实后端调用结果

初评的 RGB 跨浏览器数值仍保存在旧报告里；此处没有通过降低画质门槛或省略最差帧来宣称通过。
