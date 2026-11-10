# 产品与架构决策

## 2026-11-10：GitHub Pages 手机浏览器版

用户要求将 MemeFactory 放到 GitHub，并发布手机可用的页面。本项目增加静态浏览器版，原本机 Python／FFmpeg 版本保留。

- GitHub Pages 只提供静态文件，无法运行原 Python 服务。新 `site/` 使用浏览器 Canvas、原生视频解码和 Worker 内的 GIF 编码，构建到 `docs/`。
- 使用固定版本的 gifenc 与 gifuct-js，依赖随站点打包，不在使用时访问外部 CDN。保留第三方 MIT 许可文本。
- 素材不上传，不建立服务端处理 API、文件存储、数据库或用户系统。CSP 设置 `connect-src 'none'`。
- 为控制手机内存，GIF 最多保留 120 个采样帧、合计 1200 万像素，保留片段时长；最终编码仍按实际字节数严格验证。
- 手机提供下载、可用时的原生文件分享，以及打开结果长按保存。浏览器视频兼容性与系统保存行为不等同于真实手机已验收。
- 仅在本产品独立仓库发布，不带入其他 CodeLab 产品、真实素材、临时下载、环境或凭证。仓库默认私有；不因 Pages 发布需要擅自改为公开。
- 发布阶段 GitHub 返回 HTTP 422：当前套餐不支持私有仓库 Pages。用户随后明确选择「公开 MemeFactory 仓库并发布 GitHub Pages」，因此仅将 `AbigaleLu/MemeFactory` 设为公开，Pages 来源为 `main /docs`。网页地址由 GitHub 返回：`https://abigalelu.github.io/MemeFactory/`。
