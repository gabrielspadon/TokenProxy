import {describe,it,expect,vi} from "vitest";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
const source=readFileSync(new URL("../../src/lib/mcp/stdioSseBridge.js",import.meta.url),"utf8");
function bridge(store){
 const spawn=vi.fn(()=>{throw Error("Status must not spawn");});
 const sandbox={module:{exports:{}},console,globalThis:{...store?{__tokenproxyMcpBridges:store}:{}},require:(name)=>{
  if(name==="child_process")return{spawn};if(name==="crypto")return{};
  if(name==="@/shared/constants/coworkPlugins")return{LOCAL_STDIO_PLUGINS:[{name:"preset",title:"Fixture bridge",command:"secret-command",args:["private-argument"],toolNames:["one","two"]}]};
  throw Error("Unexpected require");
 }};
 runInNewContext(source,sandbox);return{status:sandbox.module.exports.getBridgeStatus,spawn,sandbox};
}
describe("read-only MCP bridge status",()=>{
 it("reports declared presets without creating a registry or spawning",()=>{
  const {status,spawn,sandbox}=bridge();const result=status();
  expect(result.summary).toEqual({presets:1,running:0,clients:0});
  expect(result.presets[0]).toMatchObject({installation:"not-probed",endpoint:"/api/mcp/preset/sse",declaredToolCount:2});
  expect(spawn).not.toHaveBeenCalled();expect(sandbox.globalThis.__tokenproxyMcpBridges).toBeUndefined();
 });
 it("projects only live status and client counts while leaving handles untouched",()=>{
  const sessions=new Map([["private-session",()=>{}]]);const proc={killed:false,exitCode:null,env:{SECRET:"private-value"},kill:vi.fn()};
  const store=new Map([["preset",{proc,sessions,buffer:"private-content"}],["unknown-secret",{proc,sessions}]]);
  const {status,spawn}=bridge(store);const result=status();
  expect(result.summary).toEqual({presets:1,running:1,clients:1});
  for(const secret of ["private","secret-command","unknown-secret"])expect(JSON.stringify(result)).not.toContain(secret);
  expect(store.size).toBe(2);expect(proc.kill).not.toHaveBeenCalled();expect(spawn).not.toHaveBeenCalled();
  proc.exitCode=1;expect(status().presets[0].running).toBe(false);
 });
});
