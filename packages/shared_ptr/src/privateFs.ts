import { appendPrivate, ensurePrivateDir as ensureDir, writePrivateFile } from '@lifetimescriptkiddie/agentctl-kit/privateFs';
import { sharedPtrHome } from '@lifetimescriptkiddie/shared-ptr-contract/local';

/** 0700 dir; also tightens the shared_ptr home when `path` is inside it. */
export function ensurePrivateDir(path: string): void {
  ensureDir(path, sharedPtrHome());
}

export { appendPrivate, writePrivateFile };
