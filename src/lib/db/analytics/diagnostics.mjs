const OPERATIONS = new Set(['overview','session','activity']);
const PHASES = new Set(['validate','open','snapshot','query','release','close']);
const CODES = new Set(['SQLITE_ERROR','SQLITE_BUSY','SQLITE_LOCKED','SQLITE_CORRUPT','SQLITE_NOTADB',
  'SQLITE_READONLY','SQLITE_CANTOPEN','ERR_SQLITE_ERROR','ENOENT','EACCES','EPERM']);

// Never log exception messages, SQL, paths, filter values or raw error objects.
export function analyticsDiagnostic(error,{operation,phase}) {
  return {operation:OPERATIONS.has(operation)?operation:'unknown',phase:PHASES.has(phase)?phase:'unknown',
    code:CODES.has(error?.code)?error.code:'READ_FAILED'};
}
