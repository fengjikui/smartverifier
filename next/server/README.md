# 新版本地业务服务

使用本机Node.js 24原生TypeScript与SQLite；无独立数据库安装步骤。SQLite在当前Node版本会打印实验性API提示，不影响本阶段运行；公司部署前固定运行版本并验证。

`index.ts` 负责HTTP、会话、上传和静态文件；`service.ts` 管理任务、检测轮次、可选改判、队列、报告与模拟回填；`store.ts` 管理SQLite。共享的汇总、完成条件与文字对齐在 `../shared/`。

## 启动

在仓库根目录，使用已安装的依赖：

```sh
npm run check:next
npm run test:next
npm run build:next
npm run start:next
```

默认监听 `0.0.0.0:5190`，前端和API同源，不与旧版5188共用状态。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| SV_NEXT_PORT | 5190 | HTTP端口 |
| SV_NEXT_HOST | 0.0.0.0 | 监听地址 |
| SV_NEXT_STATE_DIR | outputs/next-state | SQLite、原图、报告 |
| SV_NEXT_MOCK_DELAY_MS | 1200 | 模拟阶段等待时间，不是模型速度配置 |

SQLite持有任务、轮次、会话、审计与回填回执；轮次JSON包含照片、元件、依据版本与AI／人工历史。原图保存在状态目录的files，Markdown报告在reports，二者不进入Git。历史轮次提交后只读，新一轮有独立ID。实际模型、IDaaS和MES后续通过适配边界替换，服务端继续计算最终汇总和提交门槛。

## API草案

当前合同用于阶段一，不代表已与MES约定最终格式。

| 方法与路径 | 用途 |
| --- | --- |
| GET /api/health | 服务状态与mock标记 |
| POST /api/session | 进入明确标注的模拟身份 |
| DELETE /api/session | 退出本地试用，草稿保留 |
| GET /api/bootstrap | 当前人员、任务列表及任务状态 |
| POST /api/tasks/:id/open | 进入任务，必要时建立首轮草稿 |
| GET /api/tasks/:id | 任务、本轮、上次有效轮及汇总，用于恢复和进度查询 |
| POST /api/tasks/:id/rounds | 成功提交后开始重检，reuse选择复用照片 |
| POST /api/rounds/:id/photos | multipart上传原图，含revision、clientId、尺寸及可选replaceId |
| POST /api/rounds/:id/sample | 添加或替换内置样例，仅本地模式 |
| POST /api/rounds/:id/remove | 明确移除本轮草稿照片 |
| POST /api/rounds/:id/notes | 更新现场说明，已有结果失效 |
| POST /api/rounds/:id/review | 人工改判、原因及审计 |
| POST /api/rounds/:id/analyze | 串行处理待检测部分 |
| POST /api/rounds/:id/submit | 仅模拟保存丝印项；失败重试沿用同一幂等键 |
| GET /api/rounds/:id/report.md | 下载图文Markdown |
| GET /api/files/:filename | 当前本地模拟会话访问原图 |

轮次变更包含revision，旧版本拒绝更新并提示刷新。文件上传通过clientId去重，允许响应丢失后重试，但不会按图片哈希错误合并不同拍摄意图。模拟任务可被同一本地试用身份处理；正式任务授权与跨人员草稿规则待认证／MES阶段对接。
