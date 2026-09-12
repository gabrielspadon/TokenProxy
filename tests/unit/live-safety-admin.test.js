import {afterEach,expect,it,vi} from 'vitest';
const guard=vi.hoisted(()=>vi.fn());
vi.mock('../../src/lib/admin/guard.js',()=>({requireAdmin:guard}));
import {GET} from '../../src/app/api/admin/live-safety/route.js';
afterEach(()=>{delete globalThis.__tokenproxyLiveSafety;guard.mockReset();});
it('returns operator denial before consulting private runtime state',async()=>{
  const denied=new Response('denied',{status:403}),snapshot=vi.fn();guard.mockResolvedValue(denied);
  globalThis.__tokenproxyLiveSafety={snapshot};
  expect(await GET(new Request('http://localhost/api/admin/live-safety'))).toBe(denied);expect(snapshot).not.toHaveBeenCalled();
});
it('preserves missing runtime and missing ACK instrumentation as explicit unknowns',async()=>{
  guard.mockResolvedValue(null);
  expect(await (await GET(new Request('http://localhost/api/admin/live-safety'))).json()).toMatchObject({unobservable:[{reason:'runtime-observer-not-installed'}]});
  globalThis.__tokenproxyLiveSafety={snapshot:()=>({schemaVersion:1,kind:'live-secret-snapshot'})};
  const result=await (await GET(new Request('http://localhost/api/admin/live-safety'))).json();
  expect(result.criticalAcknowledgments).toMatchObject({kind:'critical-ack-runtime',enabledAt:null,counters:null});
});
