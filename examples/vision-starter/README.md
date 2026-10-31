# 定位分割／轻量 OCR 最小接入示例

这份示例用于算法同事先跑通接口。**全部模型结果为模拟，不安装或运行 CV、OCR、VLM，不读取 `.env.local`，不写检验任务、正品库或 MES。**默认业务识别完全不变。

## Windows 最短步骤

需要 Git、Node.js 24。此示例运行不需要 Python、GPU 或模型权重；重新生成裁片时才需要 Pillow。

在项目根目录打开 PowerShell 或 CMD：

```powershell
git pull --ff-only
npm ci
npm run demo:vision
npm run demo:vision -- --separate --backend lightweight
```

第一条示例使用“关闭分割＋整图 VLM 模拟”；第二条使用“模拟分割＋轻量 OCR 模拟”。每次在 `var/vision-starter/run-随机名/` 新建目录，不覆盖上次结果，不操作 `var/data/`。

输出包括 `original.png`、`reference.png`（正品参考）、可选裁片、`assets.json`（ID 到本次导出文件的映射）、`input.json`、`basis.json`（正品图与检测说明）、可选 `separation.output.json`、每件 `ocr-N.input.json`／`ocr-N.output.json`、完整 `run.json`。最外层 `run.json` 的 `mode` 永远为 `mock`，其中预设合格／不合格不得导入业务系统。

中文或含空格的输出路径必须加引号：

```powershell
npm run demo:vision -- --separate --backend auto --out "D:\算法联调\第一轮 样例"
```

命令报错时退出码非 0，停止后续步骤；保留完整终端信息和这次的输入 JSON。不需要激活 `.venv`，也不使用 `source`、Bash 通配符或 macOS 路径。

## 两个独立开关

| 前置分割 | 后端 | 当前示例行为 |
| --- | --- | --- |
| 关闭（默认） | `vlm`（默认） | 原图直接交给 VLM 替身，返回双件预设结果 |
| `--separate` | `vlm` | 固定人工选框，返回裁片；VLM 替身返回逐件结果 |
| `--separate` | `lightweight` | 固定人工选框 → 每件 OCR 请求 → 严格校验响应 → 预设比对输出 |
| 任意 | `auto` | 根据正品分析参考及输入能力选一条模拟通路，并给出理由 |
| 关闭 | `lightweight` | 明确失败：当前轻量示例只支持单件裁片，不能默默打开分割或假称支持多件分组 |

可对照执行：

```powershell
npm run demo:vision -- --separate --backend vlm
npm run demo:vision -- --separate --backend auto --reference clear
npm run demo:vision -- --separate --backend auto --reference ambiguous
npm run demo:vision -- --separate --backend auto --reference low-confidence
npm run demo:vision -- --separate --backend auto --reference unknown
```

当前正品分析没有独立 `difficulty` 字段。示例复用已有的 `quality`、`confidence`、`ambiguities`：清晰、无歧义且自评分至少 0.9 时试验性推荐轻量，否则推荐 VLM；没有分割时也选择支持整图的 VLM。手动选择后端不被推荐覆盖。**0.9 未经过标定，不能当作准确率或生产放行条件。**基准参考也不能代替对当前实拍样品的判断。

本示例 `--reference` 是人为构造的测试情境，并未读取公司的正品库。联调页会显示推荐理由，低分不产生“图片模糊”或不合格结论。后续接真实模型时还需能力注册及实际样图验收。

## 网页试用

在本机 `.env.local` 中新增或修改 `SV_MODEL_DEBUG=1`，不要覆盖原有账号和模型配置。停止旧服务后执行：

```powershell
npm run build
npm start
```

再打开：

```text
http://127.0.0.1:5190/inspections/marking/debug/vision-starter
```

页面提供分割开关、后端选择、正品分析测试情境、原图定位框、裁片、模拟结果、JSON 展开和导出。首次可能需要点击“进入联调页”建立本机试用会话；不创建检验任务。

API 为 `/api/v1/inspections/marking/debug/vision-starter`：GET 检查可用性；POST 接收下面的模拟参数。它沿用已有调试保护，需已登录、调试启用且**本机直接访问**。HTTPS 网关、局域网或带转发头的请求会被拒绝，不能通过伪造头绕过。本页没有摄像头，不需要 HTTPS；真实平板检验仍用原 HTTPS 工作台。

```json
{"separate":true,"backend":"lightweight","reference":"clear"}
```

这个开关只作用于独立模拟试验，不是正式任务的模型选择开关。不要以为修改它就能使检验端调用同事的真实模型。

## 文件与样图说明

| 文件 | 内容 |
| --- | --- |
| [原始双件照片](../../fixtures/inspection/green-mat-v1/pair.png) | 已有生成样图，1536×1024，非产线实拍 |
| [basis.json](basis.json) | 正品图片资产与标准／现场说明；参考图来自已有生成样例 |
| [input.json](input.json) | 已有 `PhotoInput` 合同，绑定照片版本、方向矩阵与真实文件哈希 |
| [separation.mock.json](separation.mock.json) | 已有 `SeparationResult` 合同；固定人工选框，未进行模型检测 |
| [crop-1.png](crop-1.png)、[crop-2.png](crop-2.png) | 从全分辨率图按固定坐标真实裁出的元件及留白，未转正，角度记为 0 |
| [ocr.mock.json](ocr.mock.json) | 每件 OCR 模拟响应，左件 SV358，右件 SV385；行框只是接口占位，不是实际文字定位 |
| [reference-analysis.mock.json](reference-analysis.mock.json) | 清晰参考情境；其他路由情境在运行时构造 |
| [assets.json](assets.json) | 样例 ID 与仓库相对文件路径，跨机器时不能只传这里的本机路径 |
| [generate-fixtures.py](generate-fixtures.py) | 可选重建脚本，只按固定坐标裁片，不运行 CV 或模型 |

裁片不使用透明掩膜去掉背景，不生成笔画，不覆盖原图。OCR 分数为 `null`，模拟比对把握也为 `null`，不填假的 0.99；端到端耗时只是读文件与合同校验耗时，不是模型速度。

## 同事需要替换哪里

1. 在 [starter.ts](../../server/vision/starter.ts) 中参考 `MockSeparator`，实现已有 `ComponentSeparator.separate(input, context)`。检测可以缩图，结果须还原到方向纠正图全分辨率；提供真实裁片、像素四角和反向变换矩阵。
2. 参考 `MockOcr` 实现 `OcrAdapter.recognize(input, context)`。[ocr-contracts.ts](../../server/vision/ocr-contracts.ts) 已新增运行时合同；每件输入／输出按 `requestId`、`componentId`、照片版本、来源哈希及裁片哈希对应。失败应明确返回 `failed` 和 `error`，不能当作模糊或合格。
3. 当前示例资产解析器是固定白名单，不接任意路径／URL。接真实模型时由业务适配层解析已授权资产，登记实际裁片的尺寸和哈希；不要把模拟 ID 当成业务文件路径。
4. 取消信号为 `context.signal`。真实模块需要将取消和超时传递到实际推理任务；不能只中断网页等待而在后台继续占 GPU。
5. 同事原生结果可以先保留，再由适配器转换为合同。不要把轻量 OCR 的结果冒充 VLM；判断质量仍由 VLM，范围标记及用户现场说明也继续参与比对。

真实接线、回退、版本和业务验收仍按[初步接入方案](../../docs/定位分割与轻量OCR接入初步方案.md)实施。本轮没有安装同事模型、没有将这些开关接入生产轮次，也没有复活旧 OpenCV 流水线。

## 验证

```powershell
npm run check
npm run build
node --test --test-concurrency=1 tests/vision-starter.test.ts
```

测试使用临时目录／数据库、随机端口、模拟分析，不调用真实模型。覆盖两开关、路由缺省、非法组合、哈希与迟到响应、坐标／错误状态、中文空格路径、API 权限及不创建业务任务。GitHub Actions 已将示例命令加入 Windows／Linux 工作流；当前工作流是否通过以对应提交的 Actions 结果为准，不把 macOS 本机通过当成 Windows 实测。
