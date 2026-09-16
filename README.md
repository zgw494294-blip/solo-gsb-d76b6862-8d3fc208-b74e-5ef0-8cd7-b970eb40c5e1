# 舞台排演提示单（Stage Cue Sheet）

舞台排演提示单 Web 应用：按部门管理排演提示，支持前置依赖（含延迟）、锁定开场时间、
拓扑级联重算、循环依赖拒绝、冲突链标注、部门筛选与可缩放时间轴。数据存储于 SQLite，刷新不丢失。

- 后端：FastAPI + SQLite（Python 标准库 sqlite3）
- 前端：原生 HTML / CSS / JavaScript（无构建步骤）

## 一键启动（Docker）

```bash
docker compose up --build
```

启动后访问：**http://localhost:8000**

数据库文件存放在命名卷 `cues-data` 中，容器重建、重启后数据不丢失。
数据库表结构在容器启动时自动初始化，无需手动迁移。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `APP_PORT` | `8000` | 应用监听端口。修改后需同步调整 `compose.yaml` 的端口映射（如 `"8080:8080"`）。 |
| `APP_DB_PATH` | 容器内 `/data/cues.db`；本地运行 `data/cues.db` | SQLite 数据库文件路径。 |

配置方法：在 `compose.yaml` 的 `environment` 段修改，或启动时传入，例如：

```bash
APP_PORT=8080 docker compose up --build   # 同时把 ports 改为 "8080:8080"
```

## 本地开发（不用 Docker）

```bash
pip install -r requirements.txt
uvicorn backend.main:app --reload
```

访问 http://localhost:8000 ，数据库默认写入 `./data/cues.db`。

## 功能说明

- **提示（Cue）**：部门、名称、时长，可选锁定开场秒数。
- **依赖**：一条提示可依赖多条前置提示，每条依赖带独立延迟（秒）。
  未锁定提示的开始时间 = 所有前置「结束时间 + 延迟」的最大值（无前置则为 0）。
- **级联重算**：任何增删改后，后端按拓扑顺序重算全部开始时间。
- **循环依赖**：新增依赖若成环，接口返回 `409` 并拒绝写入。
- **锁定冲突**：锁定时间早于依赖允许时间时保留锁定值，该提示在时间轴上标红（⚠），
  点击后详情面板展示完整冲突链，链上节点在时间轴上以虚线框标出，可点击跳转。
- **筛选与缩放**：按部门勾选筛选；`＋/－` 按钮、「适应宽度」或 Ctrl+滚轮缩放时间轴。

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/cues` | 列出全部提示（含计算后的 start/end/earliest、冲突与冲突链、依赖列表）及部门列表 |
| POST | `/api/cues` | 新增提示 `{department, name, duration, locked_start?}` |
| PUT | `/api/cues/{id}` | 更新提示基本字段 |
| DELETE | `/api/cues/{id}` | 删除提示（其依赖级联删除） |
| POST | `/api/cues/{id}/dependencies` | 新增依赖 `{depends_on, delay}`，成环返回 409 |
| DELETE | `/api/cues/{id}/dependencies/{dep_id}` | 删除依赖 |

## 项目结构

```
├── Dockerfile / compose.yaml   # 容器化一键启动
├── requirements.txt
├── backend/
│   ├── main.py                 # FastAPI 路由与响应组装
│   ├── scheduler.py            # 拓扑排序、级联重算、成环检测、冲突链
│   └── database.py             # SQLite 连接与建表
└── frontend/
    ├── index.html
    ├── style.css
    └── app.js                  # 时间轴渲染、筛选、缩放、编辑弹窗
```
