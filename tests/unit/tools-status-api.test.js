import {beforeAll,expect,it,vi} from "vitest";
vi.hoisted(()=>{process.env.JWT_SECRET="tools-api-fixture-secret-at-least-thirty-two";});
const mocks=vi.hoisted(()=>({status:vi.fn(()=>({scope:"local-process",presets:[],summary:{presets:0,running:0,clients:0}}))}));
vi.mock("@/lib/mcp/stdioSseBridge",()=>({getBridgeStatus:mocks.status}));
const {GET}=await import("../../src/app/api/tools/route.js");
const {createDashboardAuthToken}=await import("../../src/lib/auth/dashboardSession.js");
let cookie;beforeAll(async()=>{cookie=await createDashboardAuthToken();});
const request=(operator)=>({url:"http://localhost/api/tools",method:"GET",headers:new Headers(),cookies:{get:()=>operator?{value:cookie}:undefined}});
it("rejects anonymous access before reading process state",async()=>{
 mocks.status.mockClear();expect((await GET(request(false))).status).toBe(401);expect(mocks.status).not.toHaveBeenCalled();
});
it("returns a no-store snapshot to an authenticated operator",async()=>{
 const result=await GET(request(true));expect(result.status).toBe(200);expect(result.headers.get("cache-control")).toBe("no-store");expect((await result.json()).scope).toBe("local-process");
});
it("reports unavailable without disclosing process errors",async()=>{
 mocks.status.mockImplementationOnce(()=>{throw Error("sensitive process environment");});const result=await GET(request(true));expect(result.status).toBe(500);expect(await result.text()).not.toContain("sensitive");
});
