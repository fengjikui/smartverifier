/** 统一启动入口：配置留在本机，前端与 API 同源。 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runStandalone } from '../server/index.ts';
const config=fileURLToPath(new URL('../.env.local',import.meta.url));
if(existsSync(config))process.loadEnvFile(config);
runStandalone();
