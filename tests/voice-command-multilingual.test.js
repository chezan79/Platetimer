'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {parse, numberize} = require('../public/js/voice-command-parser');
const departments=[{id:'cucina',name:'Cucina',active:true},{id:'pizzeria',name:'Pizzeria',active:true},{id:'cold',name:'Cucina fredda',active:true},{id:'inactive',name:'Bar',active:false}];
const good=[
 ['it-IT','Tavolo dodici otto minuti Pizzeria','12','pizzeria'],
 ['fr-CH','Table douze huit minutes Pizzeria','12','pizzeria'],
 ['de-CH','Tisch zwölf acht Minuten Pizzeria','12','pizzeria'],
 ['it-IT','Tavolo ventotto 8 minuti Pizzeria','28','pizzeria'],
 ['fr-CH','Table quatre-vingt-douze huit minutes Pizzeria','92','pizzeria'],
 ['fr-CH','Table huitante et un 8 minutes Pizzeria','81','pizzeria'],
 ['de-CH','Tisch einundzwanzig acht Minuten Pizzeria','21','pizzeria'],
 ['it-IT','Tavolo 120 8 minuti Pizzeria','120','pizzeria']
];
for(const [language,phrase,table,dest] of good){
 test('recognizes '+language+' '+phrase,()=>{
  const result=parse(phrase,language,departments,'cucina');
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.tableNumber,table);
  assert.equal(result.durationMinutes,8);
  assert.deepEqual(result.departmentIds,[dest,'cucina']);
 });
}
for(const phrase of [
 'Tavolo 12 8 minuti Reparto ignoto',
 'Tavolo 12 8 minuti Bar',
 'Tavolo 12 8 minuti Pizzeria e Reparto ignoto',
 'Tavolo 12 101 minuti Pizzeria',
 'Tavolo 12 otto minuti Tavolo 13 Pizzeria',
 'Tavolo 12 Pizzeria'
]){
 test('rejects invalid voice command '+phrase,()=>assert.equal(parse(phrase,'it-IT',departments,'cucina').ok,false));
}
test('French department alias resolves to canonical ID',()=>{const r=parse('Table douze huit minutes cuisine froide','fr-CH',departments,'cucina');assert.equal(r.ok,true,JSON.stringify(r));assert.deepEqual(r.departmentIds,['cold','cucina']);});
test('German department alias resolves to canonical ID',()=>{const r=parse('Tisch zwölf acht Minuten Küche','de-CH',departments,'cucina');assert.equal(r.ok,true,JSON.stringify(r));assert.deepEqual(r.departmentIds,['cucina']);});
test('rejects unlisted language',()=>assert.equal(parse('Table douze huit minutes Pizzeria','en-US',departments,'cucina').code,'INVALID_LANGUAGE'));
test('rejects unknown own department',()=>assert.equal(parse('Tavolo 12 8 minuti Pizzeria','it-IT',departments,'foreign').code,'INVALID_OWN_DEPARTMENT'));
test('does not default unknown destination to own department',()=>assert.equal(parse('Tavolo 12 otto minuti Friggitoria','it-IT',departments,'cucina').ok,false));
test('normalizes Swiss-German spelling',()=>assert.equal(numberize('zweiunddreissig','de'),'32'));
