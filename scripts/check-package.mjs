import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=resolve(process.argv[2] ?? '.');
const {default: extension}=await import(pathToFileURL(join(root,'dist/pi/agentctl.js')).href);
let handler;
extension({registerCommand(name,command){assert.equal(name,'agentctl');handler=command.handler;}});
const messages=[];
const home=mkdtempSync(join(tmpdir(),'agentctl-package-'));
process.env.AGENTCTL_HOME=home;
process.env.PATH='';
const ctx={cwd:home,waitForIdle:async()=>{},ui:{notify:(text,level)=>messages.push({text,level})}};
for(const command of ['help','ask --to dry_run hello','ask --to missing_backend hello','ask','orchestrate --bad goal']) {
 await handler(command,ctx);
}
assert.equal(messages.length,5);
assert.match(messages[0].text,/Usage/);
assert.match(messages[1].text,/no model was called/);
assert.equal(messages[1].level,'info');
assert.equal(messages[2].level,'error');
assert.match(messages[2].text,/missing_backend/);
assert.match(messages[3].text,/Usage/);
assert.match(messages[4].text,/Unknown flag/);
console.log('PASS: packaged Pi registration, bundled CLI without PATH, dry-run response, backend error, usage and flag validation');
