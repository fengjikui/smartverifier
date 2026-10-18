# 新版本地业务服务

使用本机Node.js 24原生TypeScript与SQLite；无独立数据库安装步骤。SQLite在当前Node版本会打印实验性API提示，不影响本阶段运行；公司部署前固定运行版本并验证。

`index.ts` 负责HTTP、会话、上传和静态文件；`service.ts` 管理任务、检测轮次、可选改判、队列、报告与模拟回填；`store.ts` 管理SQLite。共享的汇总、完成条件与文字对齐在 `../shared/`。

真实识别的接入边界见[前置分离与批量识别接口设计 v0.1](../docs/前置分离与批量识别接口设计-v0.1.md)。`vision/` 已提供合同、分批与校验；`local-pipeline.ts` 和 `local_worker.py` 已接入任务队列，执行CPU绿色台面定位及本机LM Studio双图逐件比对。白板生成用于查看，尚未启用批量送模。详见[真实识别运行说明](../docs/本机真实识别试用与部署.md)。

## 启动

在仓库根目录，使用已安装的依赖：

```sh
npm run check:next
npm run test:next
npm run build:next
npm run start:next
# 真实模型模式：npm run start:next:real
```

默认监听 `0.0.0.0:5190`，前端和API同源，不与旧版5188共用状态。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| SV_NEXT_PORT | 5190 | HTTP端口 |
| SV_NEXT_HOST | 0.0.0.0 | 监听地址 |
| SV_NEXT_STATE_DIR | outputs/next-state | SQLite、原图、报告 |
| SV_NEXT_MOCK_DELAY_MS | 1200 | 模拟阶段等待时间，不是模型速度配置 |

SQLite持有任务、轮次、会话、审计与回填回执；轮次JSON包含照片、元件、依据版本与AI／人工历史。原图保存在状态目录的files，Markdown报告在reports，二者不进入Git。历史轮次提交后只读，新一轮有独立ID。本机真实模型已经接入；IDaaS和MES后续通过适配边界替换，服务端继续计算最终汇总和提交门槛。

## API草案

当前合同用于阶段一，不代表已与MES约定最终格式。

| 方法与路径 | 用途 |
| --- | --- |
| GET /api/v1/inspections/marking/health | 服务状态；recognition单独标记真实识别模式，企业集成仍为mock |
| POST /api/v1/inspections/marking/session | 进入明确标注的模拟身份 |
| DELETE /api/v1/inspections/marking/session | 退出本地试用，草稿保留 |
| GET /api/v1/inspections/marking/bootstrap | 当前人员、任务列表及任务状态 |
| POST /api/v1/inspections/marking/tasks/:id/open | 进入任务，必要时建立首轮草稿 |
| GET /api/v1/inspections/marking/tasks/:id | 任务、本轮、上次有效轮及汇总，用于恢复和进度查询 |
| POST /api/v1/inspections/marking/tasks/:id/rounds | 成功提交后开始重检，reuse选择复用照片 |
| POST /api/v1/inspections/marking/rounds/:id/photos | multipart上传原图，含revision、clientId、尺寸及可选replaceId |
| POST /api/v1/inspections/marking/rounds/:id/sample | 添加或替换内置样例，仅本地模式 |
| POST /api/v1/inspections/marking/rounds/:id/real-trial | 添加本任务指定的生成照片，后续实际调用模型，不写预设结果 |
| POST /api/v1/inspections/marking/rounds/:id/sample-set | 一次添加20张单件流程样例，clientId去重，整体保存 |
| POST /api/v1/inspections/marking/rounds/:id/remove | 明确移除本轮草稿照片 |
| POST /api/v1/inspections/marking/rounds/:id/notes | 更新现场说明，已有结果失效 |
| POST /api/v1/inspections/marking/rounds/:id/review | 人工改判、原因及审计 |
| POST /api/v1/inspections/marking/rounds/:id/analyze | 串行处理待检测部分 |
| POST /api/v1/inspections/marking/rounds/:id/submit | 仅模拟保存丝印项；失败重试沿用同一幂等键 |
| GET /api/v1/inspections/marking/rounds/:id/report.md | 下载图文Markdown |
| GET /api/v1/inspections/marking/files/:filename | 当前本地模拟会话访问原图 |

轮次变更包含revision，旧版本拒绝更新并提示刷新。文件上传通过clientId去重，允许响应丢失后重试，但不会按图片哈希错误合并不同拍摄意图。模拟任务可被同一本地试用身份处理；正式任务授权与跨人员草稿规则待认证／MES阶段对接。

## 当前部署与路径

使用新版规范路径，旧网页/API 不再注册。新增 `GET /api/v1/inspections/marking/tasks`、`GET /api/v1/inspections/marking/standards`、`GET/POST /api/v1/inspections/marking/checks` 和 `POST /api/v1/inspections/marking/rounds/:id/complete`。自主检测不执行 MES 回填。见[公司部署与迁移](../docs/公司电脑试用部署与迁移.md)。
