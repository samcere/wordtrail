# 词轨 Wordtrail 0.10 - 完全静态版

这是可直接部署到 Cloudflare Pages、GitHub Pages 或其他静态网站托管平台的版本。

## 这个版本解决了什么

- 不使用 `server.py`、Python 后端、数据库服务器或付费云资源。
- 词表、学习计划、测试进度和生成的 PDF 全部保存在当前浏览器的 IndexedDB。
- 内置 ECDICT 英汉词典，共 399,207 个可用词条，按首字母拆成 26 个静态分片。
- 所有文件均小于 Cloudflare Pages 的 25 MiB 单文件限制；最大词典分片约 4.3 MiB。
- 支持 TXT、JSON、CSV、XLS、XLSX 导入，只提取英文单词，忽略源文件已有翻译并用内置词典补全。
- 支持按每周期词数自动规划；第二周期起约 10% 为历史词复习。
- 支持在线周测、纸面周测、复测、S+ / S / A / B / C / D 评级。
- 背诵表、考试表和答案表每页最多 60 词，左右双栏、每栏最多 30 词；不足 60 词时自动均衡分栏。错题勾选卡独立成页，每页最多 150 题。
- 勾选卡包含页面核验二维码；浏览器用 OpenCV.js 和 jsQR 做透视矫正、页面匹配和涂点识别。
- PDF 在浏览器中生成，并同时保存到文档中心和触发下载；中英文字体完整嵌入 PDF，不依赖设备字体，换电脑或手机打开也不会乱码。
- 支持完整备份/恢复，备份会包含词表、计划、进度和文档中心内的 PDF。
- 包含 PWA 缓存；首次联网打开后，已使用过的词典分片和识别组件会逐步缓存。

## Cloudflare Pages 部署

最省事的方式是新建一个干净的 GitHub 仓库，把本文件夹内的内容放在仓库根目录：

1. Cloudflare 控制台进入 **Workers & Pages**，创建 **Pages** 项目并连接 GitHub 仓库。
2. Framework preset 选择 **None**。
3. Build command 留空。
4. Build output directory 填 `.`。
5. 保存并部署。

不要把旧的 `dictionary/ecdict.csv` 放进这个仓库。部署需要的是本目录 `dictionary/a.json` 到 `z.json` 的分片。

## GitHub Pages 部署

1. 把本文件夹内容放在仓库根目录并推送到 `main`。
2. 仓库 Settings -> Pages。
3. Source 选择 **Deploy from a branch**，分支选 `main`，目录选 `/ (root)`。
4. 保存后等待 GitHub Pages 给出网址。

## 数据说明

不同设备和不同浏览器不会自动同步数据，这是完全免费、无后端方案的边界。换设备前在“文档中心”点“导出完整备份”，在新设备打开网站后点“恢复备份”即可迁移。

不要用资源管理器直接双击 `index.html` 作为日常使用方式：浏览器的 `file://` 安全规则会阻止词典分片加载。部署后的 HTTPS 网站不需要你手动启动任何服务。

如果“文档中心”里还留有修复前生成的 PDF，旧文件本身不会被自动改写。更新网站后重新点击生成/下载，系统会按新的字体内嵌模板创建一个新修订版，旧文档可以自行删除。

## 目录

- `index.html` / `*.css` / `app.js`：网站界面。
- `static-service.js`：浏览器内的数据、计划、测试、PDF 和备份逻辑。
- `omr.js`：纸面答题卡核验与识别。
- `dictionary/`：已分片的英汉词典。
- `vendor/`：Excel、二维码、OpenCV、PDF 生成组件及 PDF 内嵌字体。
- `manifest.webmanifest` / `sw.js`：安装与离线缓存。
- `_headers` / `.nojekyll`：Cloudflare Pages 与 GitHub Pages 配置。

第三方开源组件和数据的许可见 `THIRD-PARTY-NOTICES.md`。

如果文档中心里已有旧版生成的乱码 PDF，请重新点击生成。新版采用新的文档模板标识，会新建一份修复后的 PDF，不会复用旧文件。
