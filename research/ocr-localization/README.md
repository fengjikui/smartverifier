# 轻量 OCR、元件定位与方向实验

独立研究目录。正常检验仍使用配置中的 VLM 整图比对；这里不会启用已退役的 CV 分离器，也不会将 OCR 分数接入生产清晰度门槛。唯一生产修正是将正品库已保存的比对文字送给 VLM 作为辅助依据，禁止据此猜补样品。

- 输入、人工粗框、主码及真值边界：[样例 manifest](../../fixtures/inspection/ocr-exploration-v1/manifest.json)。共 9 张图、63 次元件出现；其中 3 次属于人工声明的形近字探索，单列评分。
- 公开实拍图的来源及许可：[署名](../../fixtures/inspection/ocr-exploration-v1/public/ATTRIBUTION.md)。其余图片为合成，非公司实拍。
- `benchmark.py`：PP-OCRv6 tiny / small、PP-OCRv5 mobile，CPU 2 线程；整图方向分类关闭/开启，以及人工已知 ROI 的四方向搜索。**人工 ROI 不是自动定位**；方向仅按 OCR 自身分数选择，不按标准答案选择。
- `probe_sam2.py`：SAM 2.1 Tiny 的框提示和自动点网格分别计时；保留多余框和漏检。
- `create_demo.ts`：显式通过本机试用 API 添加两条演示正品和待检图片，不覆盖其他正品；只在试用身份下运行。真实账号环境请正常从页面录入。
- `probe_demo.ts`：正常 API 的真实识别（沿用服务超时），保留失败。
- `probe_vlm.ts`：隔离目录中将等待上限改为 180 秒；`--image-only` 不提供人工比对文字，`--confusable-only` 仅运行形近字图片，`--known-bad-roi` 用人工已知框逐件检查 C08/C17（不是自动定位）。不会改生产服务配置。
- 原始识别行、置信度、坐标、方向候选、耗时和采样资源在 `results-2026-11-01/`，模型权重、完整运行状态在 Git 忽略的 `outputs/`。研究结论见 [报告](../../docs/research/轻量OCR与定位方向探索-2026-11-01.md)。

## Windows 最小复现（PowerShell，仓库根目录）

需要 Python 3.12、网络下载模型。不要激活或替换生产 `.venv`，也不需要 LM Studio 来运行 CPU OCR。

```powershell
py -3.12 -m venv var\research-ocr-20261101\.venv
$researchPython = ".\var\research-ocr-20261101\.venv\Scripts\python.exe"
& $researchPython -m pip install -r research\ocr-localization\requirements.txt
& $researchPython research\ocr-localization\benchmark.py --model v6-small --out outputs\ocr-localization-20261101\windows-v6-small.json
& $researchPython research\ocr-localization\benchmark.py --model v6-tiny --out outputs\ocr-localization-20261101\windows-v6-tiny.json
& $researchPython research\ocr-localization\benchmark.py --model v5-mobile --out outputs\ocr-localization-20261101\windows-v5-mobile.json
```

首次完整调用含模型下载/加载，记录为 `cold_load_seconds`；后面的推理计时不包括该预热。每项只跑一次，不能作为稳定性能排名。可加 `--scenes tray-thirty` 缩小范围，或 `--roi-min-side 512` 比较等比例插值放大。代码和输出均使用 UTF-8；无需修改 Windows 的 GBK 系统区域。

macOS 使用 `var/research-ocr-20261101/.venv/bin/python`，其他参数相同。脚本的两线程与资源采样不会自动判断所有系统的散热状态；运行期间观察系统压力，出现过热或交互卡顿时暂停本实验。

若要往本机演示库录入图片，先按 [正品管理说明](../../docs/正品管理.md) 登录试用环境。显式运行 `create_demo.ts` 前，将已有本机试用密码临时放入环境变量 `SV_DEMO_ADMIN_PASSWORD`（账号可由 `SV_DEMO_ADMIN_ID` 指定），不要写进脚本或提交 Git。完成后清掉变量。脚本仅接受本机 trial 模式；企业账号环境从界面正常录入。

## SAM 2 探针

本次实际使用官方仓库提交 `2b90b9f5ceec907a1c18123530e92e794ad901a4`，权重为 `sam2.1_hiera_tiny.pt`。需要额外的 PyTorch / torchvision、hydra-core、iopath、matplotlib，见 [官方安装说明](https://github.com/facebookresearch/sam2#installation)。Windows 官方推荐 WSL；这部分目前只在本机 macOS CPU 实测，不声称 Windows 已验证。

```text
python research/ocr-localization/probe_sam2.py --sam-repo <官方仓库目录> --weights <tiny权重路径> --out outputs/ocr-localization-20261101/sam2-tiny.json
```

自动探针只用 8×8 点网格以限制本机开销，结果不代表调优后 SAM 2 的上限。框提示用了人工已知粗框，不能当成“无需提示的自动元件定位”。

## 评分边界

逐个元件核对完整主码；不合并 O/0、I/1、S/5 等字母数字，只忽略空白与标点。未读出、错字符、落错元件都不计正确。`false_reference_match` 仅检查已知异常样例是否出现了完整标准主码，不是完整业务放行策略；没读出的异常也不能算已成功检出。

`high_conf_unmatched_lines` 是高分但未匹配所标真值的行，可能包含引脚误检、未标注副行或其他真实文字，**不直接等同错误行**。形近字探索的期望来自设计及录入人员声明，像素本身难以排除 O/0 歧义，因此不与其余 60 次元件出现混算正确率。重复元件及正品参考均不是新的独立业务品类。没有证明“覆盖 95%”或“零误放行”。
