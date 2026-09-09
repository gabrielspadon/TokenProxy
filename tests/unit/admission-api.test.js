import { describe,it,expect,vi,beforeEach } from 'vitest';
const db=vi.hoisted(()=>({getSettings:vi.fn(),updateSettings:vi.fn()}));
vi.mock('@/lib/localDb',()=>db);
import {GET,PUT} from '@/app/api/system/admission/route.js';
beforeEach(()=>{db.getSettings.mockResolvedValue({});db.updateSettings.mockReset();});
describe('persisted admission operator controls',()=>{
 it('rejects invalid operator bounds without mutating policy',async()=>{
   const response=await PUT(new Request('http://localhost/api/system/admission',{method:'PUT',body:JSON.stringify({minStreams:20,maxStreams:2})}));
   expect(response.status).toBe(400);expect(db.updateSettings).not.toHaveBeenCalled();
 });
 it('persists the validated policy and reports effective override and process ownership',async()=>{
   const response=await PUT(new Request('http://localhost/api/system/admission',{method:'PUT',body:JSON.stringify({minStreams:2,maxStreams:10,overrideStreams:4})}));
   const value=await response.json();expect(value).toMatchObject({effectiveStreams:4,scope:'process',decision:'operator-override'});
   expect(db.updateSettings).toHaveBeenCalledWith({resourceAdmission:value.policy});
   db.getSettings.mockResolvedValue({resourceAdmission:value.policy});expect((await (await GET()).json()).effectiveStreams).toBe(4);
 });
});
