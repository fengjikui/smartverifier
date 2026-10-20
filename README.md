# 鉴微 · 丝印检测系统

面向工厂来料检验的平板 Web 应用：维护正品图片与说明，拍摄待检元件，自动定位、裁剪、转正后调用 VLM 比对，展示结论、不良数量和可追溯报告。

当前版本支持正品管理、批量导入、自主检测和模拟 MES 任务。**公司 IDaaS 与 MES 尚未接通**：自主检测结果由检验员手工录入 MES，模拟回填不代表真实保存；整张检验单始终由人员在 MES 最终提交。

## 快速开始

需要 Node.js 24.x、Python 3.12，以及可用的 npm / Python 包源。从仓库根目录执行：

```sh
npm ci
python3.12 -m venv .venv
./.venv/bin/python -m pip install -r requirements.txt
npm run build
npm start
```

Windows 使用 `py -3.12 -m venv .venv` 创建环境，再执行 `npm run python -- -m pip install -r requirements.txt`。应用和测试自动选择 Windows 的 `.venv/Scripts/python.exe` 或 macOS/Linux 的 `.venv/bin/python`，**无需激活虚拟环境**；只有自定义环境才需填写 `SV_VISION_PYTHON`。没有 VLM 配置时可离线体验明确标注的模拟流程，真实上传不会生成虚假的模型结论。

- 检验工作台：<http://127.0.0.1:5190/inspections/marking>
- 正品管理：<http://127.0.0.1:5190/inspections/marking/admin/standards>
- 平板预览：<http://127.0.0.1:5190/inspections/marking/preview/tablet>
- 模型调试：`/inspections/marking/debug/model`，需配置启用，限服务端本机访问。

管理员当前使用独立账号密码，不依赖 IDaaS。先由部署人员运行 `npm run admin:owner` 初始化系统负责人；负责人登录后在“人员与权限”添加、停用普通正品管理员，并查看授权日志。访问默认仅本机，协作录入仍通过 `npm run admin:access -- lan/local` 控制并重启。默认 `admin / admin123` 不能管理人员。详见[人员与权限说明](docs/人员与权限.md)和[部署说明](docs/部署说明.md)。

## 使用真实 VLM

复制 `config/company-trial.env.example` 为根目录 `.env.local`，填写 `SV_VLM_ENDPOINT`、`SV_VLM_MODEL`、认证及 Python 路径，再运行 `npm run start:real`。可连接本机 LM Studio 或公司兼容 HTTP VLM，无需业务电脑安装模型权重。密钥及运行数据不进入 Git。

首次使用建议：管理员新增并启用一份正品标准 → 检验端按物料及供应商选正品 → 上传照片 → 检测 → 查看结果与不良数。详见[检验员使用说明](docs/检验员使用说明.md)、[正品管理](docs/正品管理.md)和[VLM 配置](docs/VLM配置.md)。

## Windows 已有版本更新

在**原项目目录**更新：停止服务 → 备份 `.env.local` 和整个 `var/`（自定义数据／账号路径另行备份）→ 拉取 `main` → 更新依赖并构建 → 按原方式启动。原来的正品、图片、管理员账号及密码沿用，不需要重新录入或初始化管理员。

按 [Windows 更新步骤：保留正品和管理员账号](docs/部署说明.md#windows-update) 逐步操作，包含 PowerShell 命令、备份清单和 ZIP 安装的更新方式。本次还需检查旧的 `SV_VISION_PYTHON=./.venv/bin/python` 配置，注释后由系统自动选择 Windows 解释器。不要用模板覆盖已有 `.env.local`。

## 仓库结构

```text
web/           平板检验端、电脑管理端、调试页和共用 UI
server/        Node HTTP / SQLite 业务服务、OpenCV 工作器、VLM 客户端
shared/        数据类型、业务规则、接口路径和结果汇总
config/        可复制的环境配置模板
scripts/       启动、离线测试、显式烟测和演示工具
tests/        业务、HTTP、图像处理和传输测试
fixtures/      虚构生成样片及人工核对真值
templates/    正品导入模板
docs/         当前需求、使用、部署、架构和接口说明
research/      当前版本相关实验脚本、精简结果与汇报材料索引
var/           本机数据（忽略）
dist/          前端构建（忽略）
```

当前代码直接位于根目录，不再分 `next/`、旧聊天程序和早期网页原型。旧实现可通过 Git 历史恢复。默认分支 `main` 是当前版本入口。

## 开发与验证

```sh
npm run check
npm run build
npm test
npm run test:python
```

测试使用临时目录，不调用真实模型。`npm run probe:real` 才会显式运行本机 VLM 烟测，请预先配置模型并检查资源。前端开发时，在一个终端运行 `npm start`，另一个终端运行 `npm run dev`；开发页地址由 Vite 输出，默认代理 API 到 5190，非默认端口可通过 `SV_DEV_API_TARGET` 指定。

运行单独 Python 脚本可用 `npm run python -- 脚本路径`，统一解释器选择和 UTF-8 编码。Windows 迁移排查与验证边界见 [Windows 兼容性检查](docs/Windows兼容性检查.md)。

完整资料从[文档索引](docs/README.md)开始。性能与准确度以现场实拍验收为准，生成样片不能代表真实业务准确率。
