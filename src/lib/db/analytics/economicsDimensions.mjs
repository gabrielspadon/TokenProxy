export const ECONOMICS_GROUPS = [
  {value:'provider',label:'Provider',fields:['provider']},
  {value:'model',label:'Model',fields:['provider','model']},
  {value:'account',label:'Account',fields:['provider','connectionId']},
  {value:'session',label:'Explicit session',fields:['contextSessionId']},
  {value:'logical-request',label:'Logical request',fields:['logicalRequestId']},
  {value:'client-project',label:'Client project reference',fields:['projectRef']},
  {value:'client',label:'Client reference',fields:['clientRef']},
  {value:'task',label:'Task reference',fields:['taskRef']},
];
export const ECONOMICS_GROUP_VALUES=ECONOMICS_GROUPS.map(group=>group.value);
export function economicsGroupFields(groupBy) {return ECONOMICS_GROUPS.find(group=>group.value===groupBy)?.fields || [];}
export function economicsGroupKey(group,groupBy) {
  // Existing saved provider/model/account identities remain byte-compatible.
  if (['provider','model','account'].includes(groupBy)) return JSON.stringify([groupBy,group.provider ?? null,groupBy==='model' ? group.model ?? null : groupBy==='account' ? group.connectionId ?? null : null]);
  return JSON.stringify([groupBy,...economicsGroupFields(groupBy).map(field=>group[field] ?? (field==='contextSessionId' ? group.sessionId : null) ?? null)]);
}
export function economicsGroupFilters(group,groupBy) {
  if (!group) return null;
  const result={};
  for (const field of economicsGroupFields(groupBy)) {
    const key=field==='contextSessionId' ? 'sessionId' : field, value=group[field] ?? group[key];
    if (value==='') return null;
    if (value==null) {
      // Only one missing predicate is supported. A compound unspecified group
      // must not accidentally select every record in the population.
      if (result.missing) return null;
      result.missing=key;
    } else result[key]=value;
  }
  return Object.keys(result).length ? result : null;
}
