import { requireAdmin } from './guard.js';
import { adminJson, adminError } from './policy.js';
import { InvestigationError } from '../db/analytics/investigationModel.mjs';
export async function investigationResponse(request, action) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try { return adminJson(await action()); }
  catch (error) {
    return error instanceof InvestigationError ? adminError(error.status,error.code,error.message)
      : adminError(503,'state_unavailable','The saved workspace could not be read or written. Your current view is unchanged.');
  }
}
export async function readInvestigationBody(request) {
  const reader=request.body?.getReader();
  if(!reader) throw new InvestigationError('JSON body is required.');
  const chunks=[];let length=0;
  try { while(true){const {value,done}=await reader.read();if(done)break;length+=value.byteLength;
    if(length>32768){await reader.cancel();throw new InvestigationError('Saved workspace body exceeds 32 KiB.',413,'too_large');}chunks.push(value);
  }} finally {reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  const raw=new TextDecoder().decode(bytes);
  try { return JSON.parse(raw); } catch { throw new InvestigationError('Invalid JSON body.'); }
}
