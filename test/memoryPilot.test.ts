import { describe,it,expect,vi } from 'vitest';
import { runMemoryPilot } from '../packages/shared_ptr/src/pilot.js';
import { okResult } from '../src/adapters/protocol.js';

describe('agent memory pilot',()=>{
 it('delivers only current evidence in three fresh calls',async()=>{
  const received:Array<{memories:Array<{text:string;id:string;revision:number}>}>=[];
  const result=await runMemoryPilot(async(prompt,workdir)=>{
   expect(workdir).toMatch(/worker$/);
   const packet=JSON.parse(prompt.slice(prompt.indexOf('\n')+1));received.push(packet);
   const m=packet.memories[0];
   return okResult({adapter:'cursor',transport:'dry_run',durationMs:0,normalizedText:JSON.stringify({
    value:m?m.text.split(': ')[1]:null,memoryId:m?.id??null,revision:m?.revision??null,
   })});
  });
  expect(result.ok).toBe(true);expect(received).toHaveLength(3);
  expect(received[0]?.memories[0]?.text).not.toEqual(received[1]?.memories[0]?.text);
  expect(received[2]?.memories).toEqual([]);
 });
 it('stops at the first failed judgment without retry',async()=>{
  const runner=vi.fn(async()=>okResult({adapter:'cursor',transport:'dry_run',durationMs:0,normalizedText:'not JSON'}));
  const result=await runMemoryPilot(runner);
  expect(result.ok).toBe(false);expect(runner).toHaveBeenCalledTimes(1);
 });
});
