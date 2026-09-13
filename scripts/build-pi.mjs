import ts from "typescript";
import {readFileSync,writeFileSync,mkdirSync} from "node:fs";
const source=readFileSync("integrations/pi/agentctl.ts","utf8");
const result=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}});
mkdirSync("dist/pi",{recursive:true});
writeFileSync("dist/pi/agentctl.js",result.outputText);
