export const PRICING_FIELDS = {input:'Input',output:'Output',cached:'Cache read',cache_creation:'Cache write',reasoning:'Reasoning'};
export const BUDGET_USAGE_FIELDS = {input_tokens:'Input tokens',output_tokens:'Output tokens',cached_tokens:'Cache read tokens',cache_creation_input_tokens:'Cache write tokens',reasoning_tokens:'Reasoning tokens',cost_usd:'Provider-reported USD'};
export function numericFields(draft, fields, {tokens=false} = {}) {
  const result={};
  for (const key of Object.keys(fields)) {
    const value=draft[key];
    if (value==null || value==='') continue;
    if (typeof value!=='number' || !Number.isFinite(value) || value<0 || (tokens && key!=='cost_usd' && !Number.isSafeInteger(value))) throw new Error(`${fields[key]} must be a finite non-negative ${tokens && key!=='cost_usd'?'whole number':'number'}.`);
    result[key]=value;
  }
  if (!Object.keys(result).length) throw new Error('Enter at least one known value. Blank fields remain unspecified.');
  return result;
}
export function pricingPatch(provider,model,draft) {
  const unsafe=value=>!value || value.length>200 || /[\u0000-\u001f\u007f]/.test(value) || ['__proto__','prototype','constructor'].includes(value);
  if (unsafe(provider) || unsafe(model)) throw new Error('Choose an exact provider and model.');
  return {[provider]:{[model]:numericFields(draft,PRICING_FIELDS)}};
}
export function budgetResolution(apiKeyId,reservation,kind,reference,draft) {
  if (!reservation?.requestId) throw new Error('Select an exact reservation first.');
  if (!reference?.trim() || reference.length>500) throw new Error('Provide a nonsecret evidence reference of 1–500 characters.');
  return {apiKeyId,requestId:reservation.requestId,evidence:{kind,reference:reference.trim(),...(kind==='provider-usage'?{tokens:numericFields(draft,BUDGET_USAGE_FIELDS,{tokens:true})}:{})}};
}
export async function readJson(url, options) {
  const response=await fetch(url,{cache:'no-store',...options});
  const body=await response.json();
  if (!response.ok) throw new Error(body.error || `The request was refused (${response.status}).`);
  return body;
}
