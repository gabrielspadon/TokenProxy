// Deterministic synthetic JSON fixtures for the version-1 evidence contract.
export function structuralFixtures(count = 256) {
  let state=721663;
  const random=(n)=>{state=(1664525*state+1013904223)>>>0;return state%n;};
  const texts=['simple','日本語 🧭 café','quote " slash \\ newline\n','\ud800','null','{"type":"image"}',''];
  const roles=['user','assistant','tool','system','developer','model','unexpected'];
  const fixtures=[{}, {input:'plain string'}, {system:null,messages:[null,undefined],tools:[]}, {messages:[{role:'user',content:undefined}]}];
  for(let i=0;i<count;i++) {
    const messages=Array.from({length:random(12)},()=>({role:roles[random(roles.length)],content:random(2)?texts[random(texts.length)]:[
      {type:'text',text:texts[random(texts.length)]},
      {type:'tool_result',tool_use_id:'synthetic',content:[{type:'image',source:{type:'base64',data:texts[random(texts.length)]}}]},
    ],...(random(3)===0?{tool_calls:[{type:'function',function:{name:'synthetic',arguments:'{}'}}]}:{})}));
    fixtures.push({model:'synthetic-model',...(random(2)?{system:texts[random(texts.length)]}:{}),...(random(2)?{instructions:[{type:'text',text:'synthetic'}]}:{}),
      [['messages','input','contents'][random(3)]]:messages,...(random(2)?{tools:[{name:'synthetic',input_schema:{enum:[{type:'image',value:texts[random(texts.length)]}]}}]}:{}),...(random(2)?{functions:[]}:{}),stream:random(2)===1});
  }
  return fixtures;
}
