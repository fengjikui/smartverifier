# Windows 路径与编码兼容性检查

日期：2026-10-21。针对 Windows 试用反馈排查；下列为代码中确认的问题及对应修复。已通过 GitHub Actions 的 Windows Server 2025／Linux 运行验证，目标公司电脑和业务模型仍需现场核验。

## 已确认并修复的问题

| 范围 | 问题 | 处理 |
| --- | --- | --- |
| 图像识别、正品图片／批量导入、管理 HTTP 测试及推理探针 | 多处写死 `.venv/bin/python` | 统一使用 `server/python-runtime.ts`，Windows 自动选择 `.venv/Scripts/python.exe`，macOS/Linux 选择 `.venv/bin/python` |
| 配置模板 | 复制到 Windows 后仍携带 macOS 的解释器覆盖值 | 模板默认不填写 `SV_VISION_PYTHON`，由当前系统选择 |
| 解释器自定义路径 | 相对路径依赖启动时工作目录 | 相对路径按仓库根目录解析；支持中文、空格路径，直接 spawn 解释器，不拼 shell 命令 |
| Python 管道 | Windows 默认 GBK 可能误读 Node 发送的中文 JSON，或不能输出特殊字符 | 子进程固定 `PYTHONUTF8=1`、`PYTHONIOENCODING=utf-8`；三个工作器直接运行时也主动配置标准输入／输出编码，输入兼容 UTF-8 BOM |
| Node 管道 | 对每个 Buffer 单独转字符串，中文字符跨分块时可能变成乱码 | 正品管理与识别管道均使用流式 UTF-8 解码 |
| Python 文本文件 | 部分测试、实验脚本使用系统默认编码读取／写入 JSON、模板及报告 | 明确指定 `encoding='utf-8'`；Python 调 Node 的文本管道也显式指定编码 |
| 测试入口 | Shell 通配符展开存在系统差异；测试与服务可能使用不同解释器 | Node 脚本显式枚举测试文件；Node／Python 测试只读取 `.env.local` 的解释器项，不带入业务配置 |
| 资源检查、调试与研究脚本 | 无条件调用 `pmset`、`os.getloadavg` 或固定 macOS 的 CLI／字体路径 | 仅 macOS 查询 `pmset`，不可取得的负载留空；CLI 优先从 PATH 查找，白板字体用 Pillow 自带字体 |

配置了自定义解释器但路径错误时，系统会明确失败，不自动使用系统 Python。不会通过忽略编码错误或丢弃字符来获得“成功”。

## Windows 更新后的操作

已有正品和账号的电脑，先按 [Windows 保留数据更新步骤](部署说明.md#windows-update) 停服务、备份和更新代码，再检查下列环境。不要为修复 Python 环境清空业务目录或重新配置账号。

在项目根目录，用 PowerShell 执行。原来的业务库和私有配置保留，不删除。

```powershell
# 首次在本机安装时创建；已有正常的 Windows 环境可跳过。
py -3.12 -m venv .venv
& .\.venv\Scripts\python.exe -m pip install -r requirements.txt
npm ci
```

检查 `.env.local`：如果还有 `SV_VISION_PYTHON=./.venv/bin/python`，请注释或删除该行。默认选择本机 `.venv`；有特殊需要时可写：

```dotenv
SV_VISION_PYTHON="D:/检验 系统/.venv/Scripts/python.exe"
```

无需运行 `Activate.ps1` 或更改 PowerShell 执行策略。不要把 macOS 的 `.venv` 复制到 Windows，解释器项也不能填写激活脚本或整段带参数的命令。

统一验证入口：

```powershell
npm run python -- -c "import sys; print(sys.executable); print(sys.stdin.encoding, sys.stdout.encoding)"
npm run check
npm run build
npm test
npm run test:python
```

解释器检查应显示本机的 `Scripts\python.exe`，管道编码为 UTF-8。单独执行 Python 脚本时用 `npm run python -- 脚本路径 参数`；依赖更新用 `npm run python -- -m pip install -r requirements.txt`。配置修改后重启业务服务，再测试正品录入、批量导入及真实图片识别。

源码和 JSON 清单保存为 UTF-8，JSON 导入也接受 UTF-8 BOM。终端字体／代码页影响显示时，与工作器协议是否正确应分开判断；应用内部编码不再依赖手工 `chcp`。

## 本轮验证与边界

- 本机 macOS：TypeScript 检查、前端构建、56 项 Node 和 25 项 Python 测试通过。
- 直接用 `PYTHONUTF8=0`、`PYTHONIOENCODING=gbk` 启动实际图片、导入、定位工作器，传入 UTF-8 BOM JSON，使用中文＋空格＋特殊字符路径，读取及返回内容正确。特殊字符刻意选取 GBK 无法表示的字符，避免只测常用中文而漏掉问题。
- 通过逐字节输出 JSON，验证中文字符跨数据分块时，两条 Node 工作器管道不产生替代字符。
- 实际管理 HTTP 测试在中文＋空格状态目录中完成图片、Excel、JSON／图片 ZIP 预检与导入；VLM HTTP 测试使用本机固定响应服务器，不调用真实模型。
- 新增文本编码静态回归检查，防止后续脚本重新遗漏文件或文本子进程编码。
- GitHub Actions 的 Windows Server 2025／Linux + Node 24 + Python 3.12 验证均已通过：56 项 Node、25 项 Python 测试、类型检查及构建；验证代码提交 `6c8c5fe`，见 [远端运行记录](https://github.com/fengjikui/smartverifier/actions/runs/39517265580)。首轮发现全新检出缺少 `dist`，已将 CI 调整为先构建再执行 HTTP 页面测试，保留完整测试断言后重跑通过。

本轮没有操作业务数据库、修改私有配置或启动真实推理；Windows 实机、公司模型、平板摄像头仍需目标环境验证。历史研究中的 MLX 模型名、模板和日志路径不因本次兼容性修复自动变为 Windows 可用配置。
