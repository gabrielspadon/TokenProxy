import { describe,it,expect } from 'vitest';
import { pricingPatch,budgetResolution } from '@/shared/components/workspace/economicsToolsModel';
import { validateEconomicsFilters, mergeEconomicsFilters } from '@/lib/db/analytics/investigationModel.mjs';

describe('operator Economics drafts',()=>{
  it('keeps unknown rates absent and explicit zero, rejecting invalid monetary quantities',()=>{
    expect(pricingPatch('fixture','model',{input:0,output:4,cached:''})).toEqual({fixture:{model:{input:0,output:4}}});
    for(const input of [Infinity,NaN,-1,'2']) expect(()=>pricingPatch('fixture','model',{input})).toThrow();
    expect(()=>pricingPatch('__proto__','model',{input:1})).toThrow();
  });
  it('targets one exact reservation with measured quantities and nonsecret evidence reference',()=>{
    expect(budgetResolution('key',{requestId:'attempt'},'provider-usage',' receipt-7 ',{input_tokens:0,output_tokens:12,cached_tokens:''})).toEqual({apiKeyId:'key',requestId:'attempt',evidence:{kind:'provider-usage',reference:'receipt-7',tokens:{input_tokens:0,output_tokens:12}}});
    expect(()=>budgetResolution('key',{requestId:'attempt'},'provider-usage','receipt',{input_tokens:1.5})).toThrow(/whole/);
    expect(()=>budgetResolution('key',null,'provider-nonacceptance','receipt',{})).toThrow(/Select/);
  });
  it('validates explicit attribution without inventing raw client identities',()=>{
    expect(mergeEconomicsFilters({period:'all',start:null,end:null,provider:null},{filters:{}})).toEqual({});
    const clientSessionRef=`ctx1_${'a'.repeat(64)}`;
    expect(validateEconomicsFilters({clientSessionRef,sessionId:'2',requestLink:'linked'})).toEqual({clientSessionRef,sessionId:2,requestLink:'linked'});
    for(const filters of [{clientSessionRef:'raw'},{sessionId:true},{clientKeyId:'key',missing:'clientKeyId'},{body:'private'}]) expect(()=>validateEconomicsFilters(filters)).toThrow();
    expect(()=>mergeEconomicsFilters({provider:'fixture'},{filters:{missing:'provider'}})).toThrow(/conflict/);
  });
});
