import { appendPrivate, ensurePrivateDir as ensureDir, writePrivateFile } from '@agentctl/kit/privateFs';
import { agentctlHome } from './agentHome.js';

/** 0700 dir; also tightens ~/.agentctl when `path` is inside it. */
export function ensurePrivateDir(path: string): void {
  ensureDir(path, agentctlHome());
}

export { appendPrivate, writePrivateFile };
