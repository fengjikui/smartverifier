/** 显式启用真实模型；默认启动仍可离线体验预设流程。 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runStandalone } from '../server/index.ts';
const config=fileURLToPath(new URL('../../.env.next.local',import.meta.url));
if(existsSync(config))process.loadEnvFile(config);
process.env.SV_NEXT_RECOGNIZER='lmstudio';
process.env.SV_MODEL_DEBUG??='1';
runStandalone();
