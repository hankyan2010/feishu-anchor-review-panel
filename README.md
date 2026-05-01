# 主播复盘入表台 · feishu-anchor-review-panel

把抖音、视频号、快手三平台的直播间复盘截图上传到本地小工具，自动 OCR 提取关键指标，一键写入飞书多维表格，方便每场直播完成后归档分析。

## 功能

- 主播管理：新增 / 删除 / 切换主播
- 截图上传：抖音、视频号、快手三平台各一张
- OCR 识别：基于 `tesseract`（`chi_sim+eng`）提取文字与关键指标
- 自动建表：首次写入时通过飞书 OpenAPI 创建多维表格 + 字段
- 字段对齐：抖音 / 视频号 / 快手三套字段在同一行写入
- 运行日志：实时显示 OCR、写表、抽检三步进度

## 环境要求

- Node.js >= 18
- macOS / Linux / Windows
- `tesseract` 命令行（含中文简体语言包）

macOS 安装 tesseract：

```bash
brew install tesseract tesseract-lang
```

Ubuntu / Debian：

```bash
sudo apt install tesseract-ocr tesseract-ocr-chi-sim
```

## 快速开始

```bash
# 1. 克隆
git clone https://github.com/yanhan9888/feishu-anchor-review-panel.git
cd feishu-anchor-review-panel

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env 填入你的飞书 App ID / App Secret

# 3. 启动
node server.js
```

默认在 `http://localhost:3236` 提供页面。

## 飞书应用配置

在 [飞书开放平台](https://open.feishu.cn/app) 创建一个「自建应用」，并开通以下能力：

- **多维表格** 至少包含以下权限之一：
  - `bitable:app`（推荐）
  - `base:app:create`

如果首次建表接口返回权限不足，页面会直接显示去飞书后台开权限的链接。

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `FEISHU_APP_ID` | ✅ | 飞书自建应用 App ID |
| `FEISHU_APP_SECRET` | ✅ | 飞书自建应用 App Secret |
| `FEISHU_BITABLE_APP_TOKEN` | | 已有多维表的 app_token，留空则首次启动自动建表 |
| `FEISHU_BITABLE_TABLE_ID` | | 已有多维表的 table_id |
| `FEISHU_BITABLE_URL` | | 多维表浏览器链接 |
| `FEISHU_BITABLE_TABLE_NAME` | | 表名，默认「主播复盘记录」 |
| `FEISHU_BITABLE_BASE_NAME` | | 多维表 Base 名，默认「主播复盘数据台」 |
| `PORT` | | 服务端口，默认 3236 |

## 数据存储

- `data/anchors.json`：主播列表
- `data/config.json`：自动建表后回写的 appToken / tableId / tableUrl
- `data/runtime.log`：每次操作的运行日志（JSONL）
- `tmp/`：截图临时目录，OCR 完成后自动清理

以上目录均在 `.gitignore` 中，不会被提交。

## 当前状态与已知限制

- OCR 走本地 `tesseract`，对截图清晰度敏感；后续计划接入多模态大模型做识别 + 抽检。
- `/api/qa-check` 当前是占位接口，永远返回通过，等接入大模型后再补。
- 三平台的指标解析依赖关键字与列宽切分，截图布局变化会导致空值。

## License

MIT
