# MemeFactory · 表情工厂

CodeLab 第 **20** 号独立项目。把表情素材处理成更容易使用和分享的文件。

提供两个版本：**手机浏览器版**直接由 GitHub Pages 提供；**Mac 本机版**保留 Python、Pillow 和 FFmpeg 处理能力。两版的素材都只在当前设备处理，不上传素材，不需要 API Key。

## 手机浏览器版

网页：**[MemeFactory · 表情工厂](https://abigalelu.github.io/MemeFactory/)**

仓库：[AbigaleLu/MemeFactory](https://github.com/AbigaleLu/MemeFactory)

使用 GitHub Pages 页面，可在 Safari／Chrome 打开。选择照片或视频，调整参数后处理，再下载到「文件」；支持的设备还可调用系统分享，或打开结果后长按保存。

- 三个功能均在浏览器执行，不需要电脑保持开机。
- 推荐视频格式为 H.264 MP4；MOV、WebM、HEVC 等能否解码取决于浏览器。不能解码时会明确报错。
- GIF 使用独立 Worker 编码，严格检查体积。最多采样 120 帧、合计 1200 万像素；较长片段会降低采样帧率，保留片段时长。
- 去白底处理超大图时，最多保留 1200 万像素。图片瘦身仍按所选最长边导出。
- 支持 20 MB 以内的动态 GIF 重新压缩。静态图片支持 PNG、JPG、WebP、BMP；TIFF／HEIC 不作为跨浏览器保证格式。
- 素材只驻留当前页面内存；刷新或关闭页面后清除，处理完成请及时保存。处理时保持页面在前台。
- 不包含外部 CDN、遥测或上传接口；CSP 禁止页面发出处理网络请求。网页本身由 GitHub 提供。

开发静态版：

```sh
npm ci
npm run build
npm test
npm run preview
```

访问 `http://localhost:8766`。构建产物位于 `docs/`，GitHub Pages 从 `main /docs` 发布，资源路径支持项目子目录。依赖许可证随站点一并发布。

## 启动

双击 **`启动 MemeFactory.command`**，浏览器会打开 `http://localhost:8765`。保持启动后的终端窗口运行，用完按 `Control+C` 退出。

也可以从项目目录运行：

```sh
python3 app.py
```

需要 Python 3.11 或以上、Pillow 11–12，以及带 `ffprobe` 的 FFmpeg。本机开发验证环境为 Python 3.14、Pillow 12.2、FFmpeg 8.1.2。

如果缺少 Pillow，双击启动脚本会在本项目 `.venv` 中安装依赖。FFmpeg 缺失时图片功能仍可用；视频功能需要先执行：

```sh
brew install ffmpeg
```

端口被占用时：

```sh
python3 app.py --port 8766
```

## 三个工具

| 工具 | 能力 | 输出 |
| --- | --- | --- |
| 去除白底 | 去除与四边相连的近白色背景，调节白色阈值和柔化；可切换为全图去白 | 透明 PNG |
| 视频转 GIF | 截取 0.1–15 秒，选择起点、尺寸、帧率和体积上限；自动调整尺寸、帧率、色数 | 实测小于目标体积的循环 GIF |
| 图片瘦身 | 等比缩放、不放大小图；按体积目标调节质量，必要时继续缩小 | WebP / PNG / JPG |

- **500 KB 按 500,000 字节计算，必须严格小于。** 不会把超过上限的 GIF 标记为成功。
- 视频不为了压缩而自动缩短所选片段；所选终点超过素材结尾时，截取到素材结尾。GIF 时间精度受帧率和 GIF 的 10 ms 时间单位影响。
- 尺寸与帧率为期望值。最终尺寸、体积、实际编码帧率显示在结果区。长边同时约束横屏、竖屏。
- 默认边缘去白保留被主体包围的白色。浅色主体与背景相连时也可能被移除，可调低柔化范围或提高阈值后查看深色背景预览。这是颜色处理工具，第一版没有语义抠图。
- 图片功能处理静态图片。动态 GIF 可在「视频转 GIF」中重新压缩；其他格式的动态图暂不支持。
- 支持原图／结果对照、棋盘／白色／深色背景、拖放、更换素材、参数重置和直接下载。

## 文件与隐私

- 服务只监听 `127.0.0.1`。静态资源随项目提供，没有外部字体、统计或网络 API。
- 每次选择的素材写入系统临时目录，处理结果使用不同路径，**不覆盖原件**。
- 下载后文件由浏览器保存。退出工具会清理本次临时素材与结果，请先下载需要的文件。
- 单文件最大 150 MiB，图片最多 2500 万像素。一个运行会话最多载入 40 份素材；处理线程数为 2。
- 当前为单文件处理，尚无批量队列、原生 `.app` 安装包或 HEIC 支持。

## 开发与验证

```sh
python3 -m unittest discover -s tests -v
npm run build
npm test
python3 -m py_compile app.py processing.py
node --check web/app.js
```

测试使用程序生成的图片和视频，覆盖透明度、主体内部白色、柔化、EXIF 方向、尺寸比例、体积上限、视频片段、竖屏及本机 HTTP 上传／任务／下载链路。HTTP 测试需要允许本机回环端口。

```text
app.py                       本机服务、素材与任务生命周期
processing.py                三项实际处理能力
web/                         随项目提供的界面
site/                        手机浏览器版源码与处理 Worker
docs/                        GitHub Pages 静态构建产物
scripts/build.mjs            静态站点打包
tests/                       合成素材验证
启动 MemeFactory.command     macOS 双击启动
PROJECT_STATE.md             项目现状与下一步
DECISIONS.md                 移动网页与隐私决策
```
