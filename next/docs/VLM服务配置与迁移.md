# VLM服务配置与迁移

2026-10-18。先建立可演示的逐件识别基线，暂不继续缓存、白板吞吐或模型选型优化。

## 配置入口

模型连接统一使用 `SV_VLM_` 命名，配置只保存在服务器。平板只连接业务系统，不直接访问模型，不持有模型密钥。

```bash
# 已有 .env.next.local 时直接编辑，勿覆盖其中的其他配置。
cp -n next/config/vlm.env.example .env.next.local
npm run build:next
npm run start:next:real
```

[可复制的配置模板](../config/vlm.env.example)。更改配置后重启本系统服务；不需要为配置地址重启或重新加载模型。

| 配置 | 含义 |
| --- | --- |
| `SV_VLM_PROVIDER` | `lmstudio`为现有本机SDK；`openai-compatible`为公司HTTP接口 |
| `SV_VLM_ENDPOINT` | VLM基础地址，通常含`/v1`；也接受完整`/chat/completions`地址 |
| `SV_VLM_MODEL` | 服务实际暴露的模型名称，不一定等于下载文件名 |
| `SV_VLM_API_KEY` | 可选Bearer认证密钥；无认证则留空，密钥不写入提示词、调试记录或网页 |
| `SV_VLM_TIMEOUT_SECONDS` | 单次调用总超时，5～180秒，默认55秒 |
| `SV_VLM_EXTRA_BODY` | 可选JSON对象，用于服务支持的额外生成参数；不得覆盖模型、图片、Schema等核心参数 |
| `SV_VLM_CA_FILE` | 可选公司CA证书文件；HTTP适配保持HTTPS证书校验 |
| `SV_VLM_TEMPLATE` | 仅现有LM Studio SDK使用；公司HTTP模式不依赖本机模板或权重 |

旧`SV_LM_ENDPOINT / SV_LM_MODEL / SV_LM_TEMPLATE`仅保留兼容，新变量优先，新部署统一填写VLM名称。`SV_VISION_INPUT_LAYOUT`与`SV_VISION_SCHEMA`保持已验证默认值，当前不改动优化策略。

## 公司内网示例

```dotenv
SV_VLM_PROVIDER=openai-compatible
SV_VLM_ENDPOINT=http://vlm.company.internal:8000/v1
SV_VLM_MODEL=company-vision-model
SV_VLM_API_KEY=
SV_VLM_TIMEOUT_SECONDS=90
SV_MODEL_DEBUG=0
```

`vlm.company.internal`与模型名都是占位符。仅改配置不能把不兼容接口变成兼容接口；首次联调需要公司模型服务提供：

1. 服务地址、实际模型名、认证方式和可访问网络。
2. `POST /chat/completions`，支持消息中的PNG Data URL图像、`stream:true`的SSE流、`finish_reason`及JSON Schema参数。
3. `response_format:{type:"json_schema",json_schema:{name,strict:true,schema}}`的支持情况；若不支持，明确报错，不自动撤掉Schema重试。
4. 模型是否启用思考，以及关闭思考的服务参数。HTTP模式不声称已自动关闭所有模型的思考；不提供token用量时调试页显示“未记录”，不猜测。

这遵循[vLLM结构化输出接口](https://docs.vllm.ai/en/latest/features/structured_outputs/)的兼容形式。服务器使用昇腾或NVIDIA不影响浏览器及业务接口，但仍须由公司服务确认其模型、运行时及多模态／Schema支持。公司实际服务尚未取得地址，**尚未完成公司端联调**。

## 验证与故障处理

`GET /api/health`的`recognition.mode`为`vlm`时表示业务服务已启用真实模型适配器，并返回provider及模型名；不代表已经完成网络连通或模型可用探测。`visionConfiguration`显示当前输入编排及Schema方式，健康接口不会返回密钥。

本机调试页仍为 `/debug/model`，需显式启用且只允许服务器本机查看。HTTP适配保留输入图像、实际Schema和流事件；首字与速率是客户端计时，LM Studio SDK返回的统计另按SDK口径记录。401／429／服务器错误、截断、超时及结构错误均保留未完成状态，不生成假合格，不允许部分提交。重试由用户显式触发，不隐式重复推理。

兼容HTTP适配已使用本地测试服务，经过真实HTTP、Python工作器、OpenCV、业务状态、报告和模拟回填的闭环测试；该测试服务返回固定结果，用于验证协议与流程，不作为模型准确率证据。本机千问实际推理单独复核。

部署保留业务服务对VLM的访问权限；不要在浏览器设置任意模型地址。适配器不继承桌面HTTP代理，也不跟随上游重定向，需要代理网关时直接配置其正式地址。公司身份、MES及管理员权限仍是独立待完成项。
