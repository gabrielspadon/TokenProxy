import { describe, expect, it } from 'vitest';
import { analyticsDiagnostic } from '../../src/lib/db/analytics/diagnostics.mjs';

describe('bounded analytics diagnostics',()=>{
  it('retains safe operation, failure phase and engine code',()=>{
    expect(analyticsDiagnostic({code:'SQLITE_ERROR',message:'SELECT sensitive FROM /private/file'},
      {operation:'activity',phase:'query'})).toEqual({operation:'activity',phase:'query',code:'SQLITE_ERROR'});
  });
  it('does not accept arbitrary values as diagnostic fields',()=>{
    const secret='private-provider-token';
    const result=analyticsDiagnostic({code:secret,message:secret,sql:secret},{operation:secret,phase:secret});
    expect(result).toEqual({operation:'unknown',phase:'unknown',code:'READ_FAILED'});
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it.each(['SQLITE_BUSY','SQLITE_CORRUPT','ENOENT','EACCES'])('distinguishes %s without paths',code=>{
    expect(analyticsDiagnostic({code,path:'/private/path'},{operation:'session',phase:'open'})).toEqual({code,operation:'session',phase:'open'});
  });
});
