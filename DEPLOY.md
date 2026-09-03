# Wordtrail 网站部署说明

这个文件夹可上传到 GitHub 后部署到 Render、Railway 等支持 Python 的平台。

## 重要限制

- 不要使用 GitHub Pages：它只能托管静态文件，无法运行 `server.py`、生成 PDF 或识别 OMR 答题卡。
- 当前版本是单服务本地应用，没有账号、数据库和多用户隔离。部署成公开网站后，访问者会共享服务器数据；免费云服务重启时，本地文件数据也可能丢失。
- 因此部署包不含你的个人词表、考试记录与已生成 PDF。它首次启动时会以空数据运行。

## 推荐部署：GitHub + Render

1. 在 GitHub 新建一个仓库，例如 `wordtrail`。
2. 上传本文件夹内全部文件，保持 `server.py` 位于仓库根目录。
3. 在 Render 选择 **New → Blueprint**，连接该 GitHub 仓库并确认 `render.yaml`。
4. 等待构建完成后，Render 会提供网站地址。

云平台会自动设置 `PORT`；`server.py` 已兼容该端口。若未来希望每位用户保留独立、长期数据，需要增加账号系统与数据库。
