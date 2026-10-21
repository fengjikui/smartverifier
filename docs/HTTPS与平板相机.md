# HTTPS 与平板相机联调

网页内连续取景依赖浏览器的安全上下文和相机权限。远程局域网 `http://IP:5190` 只能使用系统相机后备；应切换到**证书受平板信任、访问地址匹配证书**的 HTTPS，再授权相机。仅在证书警告中点击继续，不能保证浏览器开放连续取景。见 [MDN getUserMedia 安全要求](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia#security)。

实际联调设备为华为平板、自带浏览器、**HarmonyOS 6.1.0**。浏览器取景、拍摄尺寸及连续拍摄仍须在该设备实测；本机接口测试通过不代表真机验收。

## 公司内网使用公司 CA

公司已有专门 CA，正式部署沿用其信任体系，不使用本项目的临时测试 CA。优先采用公司现有 HTTPS 网关；代理路径、Host、上传和超时要求见[部署说明](部署说明.md#5-让平板访问)。

由 IT 确认业务域名并签发服务器证书，证书的 SAN 覆盖实际访问的域名或 IP；服务器提供完整中间证书链，平板由公司统一下发/安装并信任根 CA。**根 CA 公共证书不等于服务器证书；项目不需要公司 CA 的签发私钥。**服务器私钥只保留在部署主机或公司网关，更新、到期与轮换由部署人员维护。

没有现成网关时，可使用仓库自带的可选 HTTPS 转发。在现有 `.env.local` 中增加配置，不要用模板覆盖已有文件：

```dotenv
SV_HTTPS_HOST=0.0.0.0
SV_HTTPS_PORT=5443
SV_HTTPS_CERT_FILE=D:/Jianwei/certs/server-fullchain.pem
SV_HTTPS_KEY_FILE=D:/Jianwei/certs/server.key
```

先按原方式启动业务服务（例如 `npm run start:real`），再另开终端运行：

```sh
npm run https
```

转发固定连接本机 `127.0.0.1:SV_PORT`（默认 5190）；HTTPS 入口默认 5443。公司域名若为 `jianwei.company.internal`，使用 `https://jianwei.company.internal:5443/inspections/marking`。端口按实际防火墙规则开放。首次切换 HTTP → HTTPS 可能需要重新登录，原有正品和检测数据不变。改证书后只重启 HTTPS 转发。

不要在公司配置 `SV_HTTPS_TEST_CA_FILE`，就不会开放证书下载口。已有公司网关时，无需运行 `npm run https`。本机管理限制不会因通过 HTTPS 转发而解除：它仍是代理访问，远程正品维护需按原方案配置账号并打开管理员局域网访问。

**VLM 的 HTTPS 是另一个连接方向。**本页配置保护“平板 → 本系统”；若“本系统 → 公司 VLM”也使用私有 CA，继续单独配置 `SV_VLM_CA_FILE`，见 [VLM 配置](VLM配置.md)。不关闭 TLS 校验。

## 家庭/本机局域网临时联调

只需生成一次，IP 改变或证书到期再处理。需要 OpenSSL；公司已提供证书时不需要此生成工具。以下 IP 替换为开发电脑当前局域网地址：

```sh
npm run https:prepare -- 10.0.0.2
npm run https -- --config var/https/local.env
```

先保持原业务服务运行。脚本在被 Git 忽略的 `var/https/` 生成独立 CA（30 天）和服务器证书（14 天），不修改 `.env.local`，不修改电脑或平板的信任库，也不覆盖既有目录。下载口只返回公开 CA，私钥不会通过网络提供。只有测试配置启用了 `SV_HTTPS_TEST_CA_FILE`，才同时开放 HTTP 5442 下载口。

测试生成的独立配置将业务端口设为 5190；业务使用其他端口时修改 `var/https/local.env` 中的 `SV_PORT`。启动脚本也可通过 `--config` 选择其他本机配置文件；操作系统同名环境变量优先。正式公司配置不引用此测试文件。

平板操作：

1. 与开发电脑连接同一局域网，打开 `http://10.0.0.2:5442/`，核对页面 SHA-256 指纹与电脑终端一致，再下载 `/ca.cer`。
2. 在平板“设置”搜索“证书”，查找安装 CA 证书的入口，选择下载的 `jianwei-local-test-ca.cer`。测试 CA 名称为 `Jianwei Local Test CA`。不同设备/系统的菜单可能不同，以实际界面为准；不要安装 `.key` 私钥文件。
3. 重新打开浏览器，访问 `https://10.0.0.2:5443/inspections/marking`。确认没有证书警告，再进入拍照并允许相机权限。
4. 连续拍两张 → 完成 → 照片总览，检查照片数量、清晰度、横竖屏切换和删除/替换；退出拍摄后相机应停止。随后再测真实识别。

如果设置找不到 CA 安装或浏览器仍不信任，记录实际菜单和报错，继续用系统相机后备；不要关闭浏览器证书校验。华为官方[证书安装参考](https://consumer.huawei.com/cn/support/content/zh-cn16051333/)目前适用鸿蒙电脑/二合一设备，不能直接等同于本次 MatePad 的具体菜单。

生成工具不会静默替换旧 CA。IP 变化/到期时，停止 HTTPS 转发，将旧 `var/https/` 移到安全备份位置，再重新生成，并在平板更换测试 CA。测试结束可停止 HTTPS 转发并从平板删除该测试 CA；原 HTTP 业务服务不受影响。`var/https/` 包含私钥，不要发送、提交到仓库或当作业务附件上传。

## 本次验证范围

自动化用临时证书和隔离数据验证：TLS 信任与域名校验、原样上传和查询转发、同源登录、安全 Cookie、伪造代理头覆盖、跨源请求拦截、本机管理/调试限制、公开 CA 下载边界、业务离线 502。未关闭证书校验，未调用实际摄像头或真实模型。真机证书安装与连续取景由现场验证。
