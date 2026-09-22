import { describe,it,expect,afterEach,vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/memory/store.js';

const input = { workspace:'agentctl',text:'Use SQLite for memory',source:'user:turn-1',key:'event-1',providers:['cursor','claude'] as ('cursor'|'claude')[],state:'accepted' as const };
const stores:MemoryStore[]=[];
async function open(path=':memory:') {const s=await MemoryStore.open(path);stores.push(s);return s;}
afterEach(()=>{for(const s of stores.splice(0))s.close();vi.unstubAllEnvs();});
describe('memory vertical slice',()=>{
 it('requires review before a proposed claim enters retrieval',async()=>{
  const s=await open(); const m=s.save({...input,state:'proposed'});
  expect(await s.search('agentctl','SQLite','cursor')).toEqual([]);
  expect(s.review('agentctl')).toHaveLength(1);
  s.change('agentctl',m.id,1,'accept');
  expect((await s.search('agentctl','SQLite','cursor'))[0]?.revision).toBe(2);
 });
 it('filters project, provider and forgotten state',async()=>{
  const s=await open();const m=s.save(input);
  expect(await s.search('another','SQLite','cursor')).toEqual([]);
  expect(await s.search('agentctl','SQLite','jev')).toEqual([]);
  expect(await s.search('agentctl','SQLite','claude')).toHaveLength(1);
  s.change('agentctl',m.id,1,'forget');
  expect(await s.search('agentctl','SQLite','cursor')).toEqual([]);
  expect(s.history('agentctl',m.id)).toEqual([]);
  expect(s.inspect('agentctl',m.id)?.text).toBe('');
  expect(()=>s.save(input)).toThrow('suppressed');
 });
 it('deduplicates replay and detects key reuse',async()=>{
  const s=await open();expect(s.save(input).id).toBe(s.save(input).id);
  expect(()=>s.save({...input,text:'different'})).toThrow('Idempotency');
 });
 it('preserves history and rejects stale concurrent corrections after reopen',async()=>{
  const path=join(mkdtempSync(join(tmpdir(),'agentctl-memory-')),'memory.sqlite');
  const first=await open(path), second=await open(path); const m=first.save(input);
  second.change('agentctl',m.id,1,'correct','Use PostgreSQL for memory','user:turn-2');
  expect(()=>first.change('agentctl',m.id,1,'forget')).toThrow('Revision conflict');
  const reopened=await open(path);
  expect((await reopened.search('agentctl','PostgreSQL','cursor'))[0]?.text).toContain('PostgreSQL');
  expect(await reopened.search('agentctl','SQLite','cursor')).toEqual([]);
  expect(reopened.history('agentctl',m.id)).toHaveLength(2);
 });
 it('never promotes a correction to an unapproved proposal',async()=>{
  const s=await open(); const m=s.save({...input,state:'proposed'});
  expect(s.change('agentctl',m.id,1,'correct','New memory','user:2').state).toBe('proposed');
 });
 it('builds bounded packets and surfaces omitted evidence without truncating fields',async()=>{
  const s=await open();s.save({...input,text:'SQLite '+ '界'.repeat(1000)});
  const packet=await s.handoff('agentctl','SQLite','cursor','Review architecture',300);
  expect(packet.bytes).toBeLessThanOrEqual(300);expect(packet.omitted).toBe(1);
  expect(packet.packet.memories).toEqual([]);expect(packet.tokenCount).toBeNull();
  await expect(s.handoff('agentctl','SQLite','cursor','x'.repeat(1000),300)).rejects.toThrow('Required task');
 });
 it('refreshes a packet after correction or forgetting rather than reusing stale data',async()=>{
  const s=await open();const m=s.save(input);
  expect((await s.handoff('agentctl','SQLite','cursor','Continue')).packet.memories).toHaveLength(1);
  s.change('agentctl',m.id,1,'forget');
  expect((await s.handoff('agentctl','SQLite','cursor','Continue')).packet.memories).toEqual([]);
 });
 it('blocks nested worker mutation and unrestricted local reads',async()=>{
  const s=await open();s.save(input);vi.stubEnv('AGENTCTL_WORKER_DEPTH','1');
  expect(()=>s.save({...input,key:'2'})).toThrow('operator');
  expect(()=>s.review('agentctl')).toThrow('operator');
  await expect(s.search('agentctl','SQLite','local')).rejects.toThrow('operator');
  expect(await s.search('agentctl','SQLite','cursor')).toHaveLength(1);
 });
 it('treats query syntax as data and rejects invalid limits',async()=>{
  const s=await open();s.save(input);
  expect(await s.search('agentctl','?!','cursor')).toEqual([]);
  await expect(s.search('agentctl','SQLite','cursor',NaN)).rejects.toThrow();
  await expect(s.search('agentctl','SQLite','arbitrary')).rejects.toThrow();
 });
});
