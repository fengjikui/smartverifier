import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import http from "node:http";

const root = fileURLToPath(new URL("..", import.meta.url));
const python = path.join(root, "agent-tools/image-focus/.venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
if (!fs.existsSync(python)) throw new Error("请先在 agent-tools/image-focus 运行 uv sync --extra mcp --extra lmstudio --extra web");
const candidates = Object.entries(os.networkInterfaces()).flatMap(([name, entries]) =>
  /^(en\d|eth|wlan|Wi-Fi|WLAN|Ethernet|以太网)/i.test(name) ? (entries || []).filter(n => n.family === "IPv4" && !n.internal && /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(n.address)).map(n => n.address) : []);
const advertise = process.env.SV_LAN_IP || candidates[0] || "127.0.0.1";
const port = Number(process.env.SV_LAN_PORT || 5188);
// Python handles images/SDK on loopback; the existing Node runtime is the LAN entry point.
const reservation = http.createServer();
await new Promise((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
const backendPort = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const args = ["-m", "smartverifier_focus.web", "--state", path.resolve(process.env.SV_STATE_DIR || path.join(root, "outputs/lan-state")), "--static", path.resolve(process.env.SV_STATIC_DIR || path.join(root, "outputs/lan-web/dist")), "--advertise", advertise, "--host", "127.0.0.1", "--port", String(backendPort), "--public-port", String(port)];
const child = spawn(python, args, { cwd: root, stdio: "inherit", env: { ...process.env, HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "" } });
const server = http.createServer((req, res) => {
  const upstream = http.request({ hostname: "127.0.0.1", port: backendPort, method: req.method, path: req.url, headers: req.headers, timeout: 120000 }, reply => {
    res.writeHead(reply.statusCode || 502, reply.headers); reply.pipe(res);
  });
  upstream.on("timeout", () => upstream.destroy(new Error("Backend timeout")));
  upstream.on("error", () => { if (!res.headersSent) res.writeHead(503, { "Content-Type": "application/json" }); res.end(JSON.stringify({ detail: "电脑服务正在启动，请稍后重试。" })); });
  req.on("aborted", () => upstream.destroy()); req.pipe(upstream);
});
server.on("error", error => { console.error(error.message); child.kill("SIGTERM"); process.exitCode = 1; });
server.listen(port, "0.0.0.0");
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { server.close(); child.kill(signal); });
child.on("error", error => { console.error(error.message); server.close(); process.exitCode = 1; });
child.on("exit", code => { server.close(); process.exit(code || process.exitCode || 0); });
