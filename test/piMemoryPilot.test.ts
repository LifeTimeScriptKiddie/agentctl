import { describe,it,expect,vi,afterEach } from 'vitest';
const {execute}=vi.hoisted(()=>({execute:vi.fn()}));
vi.mock('node:child_process',async()=>{
 const {promisify}=await import('node:util');
 return {execFile:Object.assign(()=>{}, {[promisify.custom]:execute})};
});
import extension,{parseWorkerArgs} from '../integrations/pi/agentctl.js';
afterEach(()=>vi.clearAllMocks());
describe('Pi memory pilot command',()=>{
 it('calls the JSON memory CLI without adding incompatible --format flags',async()=>{
  let handler: (args:string,ctx:unknown)=>Promise<void> = async()=>{};
  extension({registerCommand:(_name:string,definition:{handler:typeof handler})=>{handler=definition.handler;}} as never);
  execute.mockResolvedValue({stdout:JSON.stringify({ok:true,directory:'/test',stages:[{stage:'recall',passed:true},{stage:'correction',passed:true},{stage:'forget',passed:true}]})});
  const notify=vi.fn();await handler('memory-test',{cwd:'/test',waitForIdle:async()=>{},ui:{notify}});
  expect(execute.mock.calls[0]?.[1].slice(-2)).toEqual(['memory','test']);
  expect(execute.mock.calls[0]?.[1]).not.toContain('--format');
  expect(notify.mock.calls[0]?.[0]).toContain('✓ forget');
 });
 it('shows a failed-stage result from a nonzero CLI exit',async()=>{
  let handler: (args:string,ctx:unknown)=>Promise<void> = async()=>{};
  extension({registerCommand:(_name:string,definition:{handler:typeof handler})=>{handler=definition.handler;}} as never);
  execute.mockRejectedValue({stdout:JSON.stringify({ok:false,directory:'/test',stages:[{stage:'recall',passed:false}],error:'failed check'})});
  const notify=vi.fn();await handler('memory-test',{cwd:'/test',waitForIdle:async()=>{},ui:{notify}});
  expect(notify.mock.calls[0]?.[0]).toContain('failed check');
  expect(notify.mock.calls[0]?.[1]).toBe('error');
 });
 it('loads a local resume briefing without --format json',async()=>{
  let handler: (args:string,ctx:unknown)=>Promise<void> = async()=>{};
  extension({registerCommand:(_name:string,definition:{handler:typeof handler})=>{handler=definition.handler;}} as never);
  execute.mockResolvedValue({stdout:JSON.stringify({packet:{checkpoint:{goal:'g',state:'s',nextAction:'n',revision:1,blockers:[]},decisions:[]}})});
  const notify=vi.fn();await handler('briefing --workspace pilot',{cwd:'/test',waitForIdle:async()=>{},ui:{notify}});
  expect(execute.mock.calls.at(-1)?.[1]).toEqual(expect.arrayContaining(['memory','briefing','--workspace','pilot']));
  expect(notify.mock.calls[0]?.[0]).toContain('Goal: g');
 });
 it('memory-review parses local JSON array from CLI',async()=>{
  let handler: (args:string,ctx:unknown)=>Promise<void> = async()=>{};
  extension({registerCommand:(_name:string,definition:{handler:typeof handler})=>{handler=definition.handler;}} as never);
  execute.mockResolvedValue({stdout:JSON.stringify([{id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',revision:2,text:'Note body'}])});
  const notify=vi.fn();await handler('memory-review --workspace pilot',{cwd:'/test',waitForIdle:async()=>{},ui:{notify}});
  expect(execute.mock.calls.at(-1)?.[1]).toEqual(expect.arrayContaining(['memory','review','--workspace','pilot']));
  expect(notify.mock.calls[0]?.[0]).toContain('Note body');
 });
 it('memory-review parses gateway { proposed: [] }',async()=>{
  let handler: (args:string,ctx:unknown)=>Promise<void> = async()=>{};
  extension({registerCommand:(_name:string,definition:{handler:typeof handler})=>{handler=definition.handler;}} as never);
  const prev=process.env.AGENTCTL_GATEWAY_URL;
  process.env.AGENTCTL_GATEWAY_URL='http://gw:8741';
  execute.mockResolvedValue({stdout:JSON.stringify({proposed:[{id:'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',revision:1,text:'Gateway item'}]})});
  const notify=vi.fn();await handler('memory-review',{cwd:'/test',waitForIdle:async()=>{},ui:{notify}});
  expect(execute.mock.calls.at(-1)?.[1]).toEqual(expect.arrayContaining(['memory','gateway','review']));
  expect(notify.mock.calls[0]?.[0]).toContain('Gateway item');
  if(prev===undefined) delete process.env.AGENTCTL_GATEWAY_URL; else process.env.AGENTCTL_GATEWAY_URL=prev;
 });
 it('parseWorkerArgs accepts briefing and gateway flags',()=>{
  expect(parseWorkerArgs('--briefing-workspace team-a -- What next')).toEqual([
    '--briefing-workspace','team-a','--','What next',
  ]);
 });
});
