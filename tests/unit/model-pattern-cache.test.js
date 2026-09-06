import { expect, it } from 'vitest';
import { matchPattern, PATTERN_PRICING, getPricingForModel } from '../../open-sse/providers/pricing.js';

function reference(pattern, model) {
  return new RegExp('^'+pattern.split('*').map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*')+'$','i').test(model);
}
it('preserves wildcard escaping and case behavior across reuse and eviction',()=>{
  const patterns = [...PATTERN_PRICING.map(row=>row.pattern),'model.+','a[b]','x\\y','a?b','a*b*c','*',''];
  const names=['Model.+','modelX','a[b]','x\\y','a?b','a-b-C','','prefix/model-v2'];
  for(let round=0;round<3;round++) {
    for(const pattern of patterns) for(const name of names) expect(matchPattern(pattern,name)).toBe(reference(pattern,name));
    for(let index=0;index<300;index++)expect(matchPattern(`eviction-${index}*`,`eviction-${index}-model`)).toBe(true);
  }
});
it('does not reuse results between different models or changed policy expressions',()=>{
  expect(matchPattern('fixture-*','fixture-a')).toBe(true);
  expect(matchPattern('fixture-*','other')).toBe(false);
  expect(matchPattern('other-*','fixture-a')).toBe(false);
  expect(matchPattern('fixture-*','FIXTURE-a')).toBe(true);
  const known=getPricingForModel('openai','gpt-4o');
  for(let index=0;index<100;index++) {
    expect(getPricingForModel('openai','gpt-4o')).toEqual(known);
    expect(getPricingForModel('fixture','uncatalogued-fixture-model')).toBeNull();
  }
});
