// Single source: @lifetimescriptkiddie/agentctl-kit/ownerToken (shared with shared_ptr).
// agentctl passes its own exec layer so the vitest real-exec guard still applies.
import {
  checkListenerOwner as kitCheckListenerOwner,
  parseLsofUids,
  type ListenerOwnerResult,
} from '@lifetimescriptkiddie/agentctl-kit/ownerToken';
import { run } from './exec.js';

export { parseLsofUids, type ListenerOwnerResult };

export function checkListenerOwner(
  port: number,
  label: string,
  unverifiable: 'allow' | 'deny',
  address?: string,
): Promise<ListenerOwnerResult> {
  return kitCheckListenerOwner(port, label, unverifiable, address, (args) => run('lsof', args, { timeoutMs: 3000 }));
}
