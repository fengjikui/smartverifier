# Unlimited OCR 2 元件丝印独立实验

本目录不接入正常检验，不修改现有 VLM、分离器、正品库和任务结果。使用现有公开／合成样片，先测盲读文字，再观察已知异常码能否被完整读出；不把 OCR 原文直接当作合格结论。

本轮结果：[中文实测报告](../../docs/research/Unlimited-OCR-2丝印独立实测-2026-11-02.md)、[静态图片与原文对照](report.html)、[7 组完整 JSON 和资源采样](results-2026-11-02/)。默认整图完整主码计数为 1/60，人工单件 ROI 为 4/14；这不满足当前默认识别要求，未更换业务后端。

## 输入与评分

- [样片及人工真值](../../fixtures/inspection/ocr-exploration-v1/manifest.json)：9 张图，63 次元件出现。60 次有像素核对主码；3 次形近字只有设计／人工声明，单列观察。公开照片保留原有[许可与署名](../../fixtures/inspection/ocr-exploration-v1/public/ATTRIBUTION.md)。
- `control.png` 是程序排出的 6 行清晰文字，仅检查运行链路，不计入元件准确度。
- `whole`：整图输入，统计完整主码出现次数。这个计数不证明文字已绑定到正确元件，也不证明定位完整。
- `roi`：16 个**人工已知位置**的裁片，其中 14 个像素核验、2 个形近字观察。用于隔离识字问题，不能当作自动分割效果。
- `upright`：其中 3 个已知倒置／侧向裁片按人工已知角度转正，用于方向对照。
- 所有主码严格匹配，不把 O/0、I/1、S/5、G/6、B/8 合并。空结果、截断、资源中止均保留，不当作成功。
- 本轮不提供标准答案、正品文字或正品图给模型，避免用参考答案猜补待检文字。没有测试外观解释、可变区域规则和完整业务报告。

## 本机复现

本轮选择 Apple Silicon 上的原生 MLX 实现，BF16 未量化权重。它是社区移植，**不是官方 NVIDIA 运行环境**，速度和准确度不能冒充官方服务器基准。来源、固定提交及运行时代码哈希见 [provenance.json](provenance.json)。

从仓库根目录运行，另建环境，不替换业务 `.venv`：

```sh
python3.12 -m venv var/research-unlimited-ocr2-20261101/.venv
var/research-unlimited-ocr2-20261101/.venv/bin/python -m pip install -r research/unlimited-ocr2/requirements-mac.txt
var/research-unlimited-ocr2-20261101/.venv/bin/python research/unlimited-ocr2/download.py
var/research-unlimited-ocr2-20261101/.venv/bin/python research/unlimited-ocr2/test_score.py
var/research-unlimited-ocr2-20261101/.venv/bin/python research/unlimited-ocr2/benchmark.py --model var/research-unlimited-ocr2-20261101/model-bf16 --out outputs/unlimited-ocr2-20261102/smoke.json --phase smoke
```

阳性对照正常后，将最后一条的 `--phase` 与输出文件名依次改为 `whole`、`roi`、`upright`。`whole --scenes tray-thirty` 可只测托盘图。可选 `plain-prompt` 改为普通读字指令；`base-mode` 关闭单页动态分块，仅作诊断，不能挑选最好结果冒充统一基线。

实际额外诊断的参数（输出文件名分别用 `plain-prompt.json`、`free-ocr.json`、`grounding-ocr.json`）：

```text
--phase plain-prompt --scenes scattered-six tray-thirty eighteen-two-differences
--phase whole --scenes scattered-six eighteen-two-differences --prompt 'Free OCR.'
--phase whole --scenes scattered-six eighteen-two-differences --prompt '<|grounding|>OCR this image.'
```

`base-mode` 仅为预留诊断选项，本轮没有运行。完成 7 组后运行 `snapshot.py` 生成结果快照与静态对照页，再运行 `validate_results.py` 核对图片哈希、原文重评分及汇总一致性。该快照只更新本研究目录；其他电脑重新生成前保留原提交中的结果以便对照。

默认单次最多 120 秒；整图最多 2048 个输出 token，裁片 512 个。GPU 内存上限 9 GiB、缓存 128 MiB，串行调用；可用内存不足 13 GiB 时不加载，不足 4 GiB 时停止后续生成。模型加载、首字和完整输出分别计时。每项之间留间隔，运行期间记录内存、负载和系统热状态；出现热警告或交互卡顿时停止本实验进程。计时含输入处理、视觉编码及生成，不含下载与加载；每项仅运行一次，不能当作稳定吞吐。

### Windows 与 NVIDIA

MLX 不适用于 Windows。本目录的本机实测不能通过把 `.venv/bin/python` 换为 `Scripts/python.exe` 就变成 Windows 方案。需要在有 NVIDIA 的环境按[官方模型说明](https://huggingface.co/baidu/Unlimited-OCR-2#inference)另建 CUDA／Transformers 环境，复用相同图片、提示词、评分脚本和真值重新测试。官方验证配置为 Python 3.10、Torch 2.13.0、Transformers 4.52.1、NVIDIA A800 80GB；本轮未在该环境实测。

官方单页默认使用 `infer` 动态分块，指令为 `Multi page parsing.`；不能把多页 `infer_multi` 的单页全局视图当成相同预处理。`score.py` 与 `test_score.py` 仅用 Python 标准库，可在 Windows 独立运行。
