import {test} from 'node:test';
import assert from 'node:assert/strict';
import {researchTopic} from '../src/research.mjs';
import {buildStoryPrompt,classifyFootage} from '../src/creative.mjs';
test('No topics are baked in; offline fact list stays empty', async()=>{
  const r=await researchTopic('unusual craft',{wiki:false});
  assert.deepEqual(r.facts,[]); assert.deepEqual(r.sources,[]);
});
test('Dynamic Wikipedia lookup ignores irrelevant search results',async()=>{
 const r=await researchTopic('honey bees',{fetchImpl:async()=>({ok:true,json:async()=>({query:{pages:[
  {title:'Video game',extract:'A'.repeat(100)},
  {title:'Honey bee',extract:'Honey bees build colonies and perform specialized jobs.'}
 ]}})})});
 assert.equal(r.facts.length,1);assert.equal(r.sources.length,1);
 assert.match(r.sources[0].url,/Honey_bee/);
});
test('Storyboard-specific but reference independent genre prompt',()=>{
 const p=buildStoryPrompt({subject:'sculpture',summary:'A sculptor turns stone into an intricate ornament',format:'process',moments:[{time:0,visible:'raw block'},{time:12,visible:'carving'},{time:19,visible:'finished decoration'}]},20,'en');
 assert.equal(classifyFootage({format:'process'}),'PROCESS');
 assert.match(p,/stone/);assert.match(p,/finished decoration/);
 assert.doesNotMatch(p,/arowana|volcano/i);
});
