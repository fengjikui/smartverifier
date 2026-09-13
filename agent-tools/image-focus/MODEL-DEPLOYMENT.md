# 本地轻量模型部署记录

本次在 Apple M2 Ultra、64 GiB 内存的 Mac、LM Studio 本地服务 `127.0.0.1:1234` 上验证。照片和识别请求仅在本机处理；外网只用于下载公开模型和依赖。以下是单张生活物品照片的兼容性冒烟记录，还不是元器件准确率评测。

## Qwen3.5-4B / MLX 4-bit

- 基础模型：[Qwen/Qwen3.5-4B](https://huggingface.co/Qwen/Qwen3.5-4B)。
- 下载版本：[mlx-community/Qwen3.5-4B-4bit](https://huggingface.co/mlx-community/Qwen3.5-4B-4bit)，社区转换的完整视觉语言模型。
- 下载约 3.06 GB，其中 safetensors 约 3.03 GB。
- 已加载新实例 `sv-qwen4b`；原有 `hr-qwen` 保留。两个模型在测试完成后均为空闲。
- LM Studio `modelKey=qwen3.5-4b`，`info.path=mlx-community/Qwen3.5-4B-4bit`；服务实际报告 `vision=true`、`trainedForToolUse=true`、当前上下文 8192。
- 下载源 revision：`0e7ffd5c629ef7719d4cbc04069232580bfa9d9c`。
- 本机模板路径：`~/.lmstudio/models/mlx-community/Qwen3.5-4B-4bit/chat_template.jinja`。

```sh
~/.lmstudio/bin/lms get https://huggingface.co/mlx-community/Qwen3.5-4B-4bit --mlx -y
~/.lmstudio/bin/lms load qwen3.5-4b --identifier sv-qwen4b --context-length 8192 --parallel 1 -y
```

请求通过现有 `LmStudioTransport`，在单次请求模板中设置 `enable_thinking=false`，不修改模型安装目录或 LM Studio 的全局配置。每次最多 350 输出 token、55 秒；不并行推理。模板保留图像和工具历史，工具 JSON Schema 不进行字段大小写转换。

本转换版本的工具历史模板使用 `args_value is sequence`，当前 LM Studio Jinja 不支持该测试；评测在请求副本中将它替换为 `args_value is iterable`，并保留模板副本。对本工具的 JSON 参数，这个替换保留列表/对象与字符串的原有处理语义。未修改安装模板。普通无工具的图片多轮聊天不经过该模板分支。

| 检查 | 实测耗时 | 输出 token | 结果 |
|---|---:|---:|---|
| 读取此前已旋正的同一标签裁片 | 4.245 秒 | 114 | 正常完成；品牌、日期、数量和条码等有输出 |
| 看整图，自主调用裁剪与旋转 | 5.686 秒 | 120 | 调用了工具，但字符串 `coordinate_space` 多带一层引号，校验拒绝执行 |
| 把参数错误反馈给模型，要求修正 | 1.570 秒 | 118 | 正确修复；真实裁剪并逆时针旋转 90° 成功 |

以上三次实际生成均为 0 思考 token。另一次工具历史请求因上述 Jinja 模板问题，在生成前被拒绝；修复请求模板后才继续。没有静默修改模型给出的参数，也没有额外再读自己裁片的第四次推理。本次证明视觉输入和工具闭环可用，但工具首轮并非全成功，识别文字也仍需人工核对。

实测结果保存在本地 `outputs/model-evaluation/qwen4b-*-response.json`，成功裁片在 `qwen4b-workspace/`。原始照片及这些结果不进入 Git。耗时为客户端单次请求时间，不包含下载；未测峰值内存、功耗或大规模平均延迟。

## PP-OCRv6 small

已安装并完成一次本地 OCR。它是文字检测与识别模型，不支持多轮对话，也不作为 LM Studio 聊天模型加载。

- 隔离环境：`outputs/model-evaluation/.venv`，Python 3.12.13。
- 依赖版本：`paddleocr==3.7.0`、`paddlepaddle==3.3.1`、`paddlex==3.7.2`、`socksio==1.0.0`。
- 模型：`PP-OCRv6_small_det` + `PP-OCRv6_small_rec`，官方 PaddleX 下载机制获取；合计磁盘约 30 MiB。隔离 Python 环境约 862 MiB。
- 推理：Paddle CPU，2 线程，识别 batch=1，检测长边最多 1280；关闭自动文档转向、曲面矫正和文本行方向分类。
- 输入：此前 27B Agent 从原图裁剪并旋转得到的同一张 1280 × 933 标签图片。
- 首次模型初始化 5.844 秒；单次 OCR 1.757 秒。共返回 31 段文字，包含文本位置及原始识别分数。
- 记录：`outputs/model-evaluation/paddle-response.json` 和 `paddle-result/` 下的完整结果。

模型读出了品牌、日期、保质期和条形码数字，也出现低分误检，与旧 27B 输出有个别字符分歧。未建立人工真值，不能把这些分数称为正确率；本次没有测从未旋正的整图自动定位、旋转的完整流程。

```sh
uv venv --python 3.12 outputs/model-evaluation/.venv
uv pip install --python outputs/model-evaluation/.venv/bin/python \
  paddleocr==3.7.0 paddlepaddle==3.3.1 socksio==1.0.0
```

官方使用方法见 [PaddleOCR PP-OCRv6](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/algorithm/PP-OCRv6/PP-OCRv6.en.md)。后续可把 OCR 包装为 Agent 的本地工具；当前手机网页仍使用 VLM 完成图片多轮问答。

## 使用边界

小模型部署本身只需要下载一次并加载，后续可在手机网页选择已加载实例。4B 适合先试日常图片问答；关键字符和细微外观差异仍需真实元器件样本验证。PP-OCRv6 small 更适合大量重复读字工作，不能独自判断器件真伪。

模型常驻内存不等于持续推理；分析完成后保持空闲。若以后需要释放新模型内存，可运行 `lms unload sv-qwen4b`，不会删除权重或影响 `hr-qwen`。
