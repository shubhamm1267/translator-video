import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateScript } from '../src/ai.mjs';
import { escapeAss, captionSegments, overlayFiles } from '../src/media.mjs';

test('video script generation normalizes time boundaries', () => {
  const x = validateScript({beats:[{start:0,end:2.9,text:'Watch this cool trick.'},{start:3,end:6,text:'It gets even better.'}],metadata:{title:'Test',tags:['shorts']}},6,'en');
  assert.equal(x.beats.length,2);assert.equal(x.beats[0].start,0);assert.equal(x.beats[0].end,3);assert.equal(x.beats[1].start,3);assert.equal(x.beats[1].end,6);
  assert.ok(captionSegments(x).length >= 2);
  for(const c of captionSegments(x)) assert.ok(c.end > c.start && c.end <= 6);
});
test('subtitle formatting strips ASS injection sequences', () => {
  assert.equal(escapeAss(' Hi {\\pos(1,2)} there! '),'Hi pos(1,2) there!');
});
test('caption chunks stay within horizontal safe area', () => {
  const script = { language:'en', beats:[{start:0,end:8,text:'antenna while everyone turns around in the busy station'}] };
  const captions = captionSegments(script, 8);
  assert.ok(captions.length >= 4);
  assert.ok(captions.every(c => c.text.length <= 18));
  assert.ok(captions.some(c => c.text === 'antenna while'));
  assert.ok(captions.some(c => c.text === 'everyone turns'));
});
test('Hindi ASS captions use a Devanagari-capable font', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clipcraft-ass-'));
  try {
    await overlayFiles(dir, {
      language:'hi',
      beats:[{start:0,end:3,text:'ये देखो, अब असली कमाल सामने आता है।'}]
    }, {captions:true, watermark:'', cta:false}, 3, 3);
    const ass = await readFile(join(dir, 'overlays.ass'), 'utf8');
    const expected = process.env.CAPTION_FONT_HI || (process.platform === 'win32' ? 'Nirmala UI' : 'Noto Sans Devanagari');
    assert.ok(ass.includes(`Style: Caption,${expected},`));
  } finally {
    await rm(dir, { recursive:true, force:true });
  }
});
test('missing valid beats causes honest error',()=>{
  assert.throws(()=>validateScript({beats:[]},10,'hi'),/empty narration/);
});

test('Interactions API model_output content can be parsed', async () => {
  const { interactionText, GEMINI_MODELS } = await import('../src/ai.mjs');
  assert.deepEqual(GEMINI_MODELS, ['gemini-3.5-flash-lite','gemini-3.8-flash','gemini-3.1-flash-lite']);
  assert.equal(interactionText({steps:[
    {type:'thought',summary:[{type:'text',text:'ignore private thinking'}]},
    {type:'model_output',content:[{type:'text',text:'{"beats":'} , {type:'text',text:'[]}'}]}
  ]}),'{"beats":[]}');
  assert.equal(interactionText({candidates:[{content:{parts:[{text:'legacy'}]}}]}),'');
});

import { applyHindiNarratorStyle, buildStoryPrompt, scriptQualityWarnings, metadataWarnings } from '../src/creative.mjs';
test('creative prompt demands concrete observations and continuous voice', () => {
 const p = buildStoryPrompt({summary:'Shoes, station, outfit demo',format:'montage',moments:[{time:0,visible:'sneakers'},{time:12,visible:'red jacket'}]},15.9,'en','funny');
 assert.match(p,/ONE CONTINUOUS spoken voiceover/);
 assert.match(p,/ENGLISH STYLE LOCK/);
 assert.match(p,/fast English Shorts explainer/);
 assert.match(p,/sneakers/);
 assert.match(p,/real visual event/);
});
test('Hindi prompt uses the Chinese-Hindi shorts style lock', () => {
 const p = buildStoryPrompt({summary:'A straw pulls liquid through a glass setup',format:'experiment',moments:[{time:0,visible:'straw in tall glass'}]},20,'hi','curious');
 assert.match(p,/HINDI STYLE LOCK/);
 assert.match(p,/Chinese-process Hindi Shorts/);
 assert.match(p,/Devanagari/);
 assert.match(p,/BEAT-SYNC CONTRACT/);
 assert.match(p,/RETENTION DESIGN/);
 assert.match(p,/Basanti|Raju|Kalu|Bunty/);
 assert.match(p,/shuddh\/formal Hindi/);
});
test('creative quality check flags short generic buzzwords', () => {
 const warnings=scriptQualityWarnings({beats:[{text:'In this video, CGI has a plot twist.'}]},{summary:'Shoes and jackets'},15.9,'en');
 assert.ok(warnings.some(w => w.includes('too sparse')));
 assert.ok(warnings.some(w => w.includes('buzzwords')));
});
test('metadata quality check rejects generic YouTube packaging', () => {
 const weak={title:'Watch the Ending! #Shorts',description:'Amazing viral shorts video. #Shorts #Viral',tags:['shorts','viral','trending','video']};
 const warnings=metadataWarnings(weak,{summary:'A mango is cut open and carved into a hollow shape',subject:'mango carving'},'en');
 assert.ok(warnings.some(w=>w.includes('hashtags in the YouTube title')));
 assert.ok(warnings.some(w=>w.includes('generic clickbait')));
 assert.ok(warnings.some(w=>w.includes('exactly 3')));
 assert.ok(warnings.some(w=>w.includes('8-12 focused tags')));
});
test('metadata quality check accepts specific packaging', () => {
 const good={
  title:'Mango Cut Open Reveals a Hollow Fruit Trick',
  description:'A fresh mango is cut open to reveal a hollow carving trick before the inside is scooped out. The final shape makes this fruit art look impossible. #MangoCarving #FruitArt #Shorts',
  tags:['mango carving','hollow mango','fruit art','mango trick','food carving','viral fruit video','satisfying carving','shorts','creative food']
 };
 assert.deepEqual(metadataWarnings(good,{summary:'A mango is cut open and carved into a hollow shape',subject:'mango carving'},'en'),[]);
});

import {classifyFootage} from '../src/creative.mjs';
import {researchTopic} from '../src/research.mjs';
test('every upload gets domain-neutral prompt; reference example is not the topic',()=>{
 const p=buildStoryPrompt({summary:'A tailor measures a jacket',format:'process',subject:'tailoring',moments:[{time:0,visible:'measure tape'}]},15,'en','funny',{},2, [{hook:'Previous jacket hook',beats:[]}]);
 assert.match(p,/tailor measures a jacket/);
 assert.match(p,/Previous jacket hook/);
 assert.match(p,/REVISION 2/);
 assert.equal(classifyFootage({format:'montage'}),'MONTAGE');
 assert.equal(classifyFootage({format:'manufacturing process'}),'PROCESS');
});
test('research unavailable is not a blocker or topic-specific preset',async()=>{
 const r=await researchTopic('a custom process',{wiki:false});
 assert.deepEqual(r.facts,[]);
 assert.deepEqual(r.sources,[]);
});
test('repeated hook triggers quality warning',()=>{
 const s={hook:'Same hook', beats:[{text:'This is a bright and extremely interesting sample about a process at work and the final reveal in the video.'},{text:'Another sentence that carries the intriguing mechanism toward the final result.'}]};
 assert.ok(scriptQualityWarnings(s,{summary:'Sample footage'},9,'en',[{hook:'Same hook'}]).some(w=>w.includes('Same hook')));
});

test('formal Hindi narration is polished toward viral shorts voice', () => {
 const formal={beats:[{text:'यह दृश्य वास्तविकता और अपेक्षा के बीच परिवर्तन प्रदर्शित करता है।'},{text:'आकृतियाँ धीरे-धीरे सामने आती हैं और प्रक्रिया पूरी होती है।'}]};
 assert.ok(scriptQualityWarnings(formal,{summary:'Sample footage'},7,'hi').some(w=>w.includes('too formal')));
 const energetic={beats:[{text:'ये देखो, शुरुआत में सब कुछ बिल्कुल अलग लग रहा है!'},{text:'लेकिन आख़िर में असली बदलाव सामने आ जाता है।'}]};
 assert.ok(!scriptQualityWarnings(energetic,{summary:'Sample footage'},7,'hi').some(w=>w.includes('too formal')));
});

test('Hindi shorts script rejects long hook and clothing-list narration', () => {
 const weak={hook:'क्या आपने इस तरह स्ट्रॉ से लिक्विड निकालने वाला साइंस का खेल देखा है',beats:[
  {text:'ये देखिए गुलाबी शर्ट पहने युवती लंबे ग्लास से लिक्विड निकाल रही है।'},
  {text:'एक के बाद एक बेज स्वेटर और लाल हूडी पहने लोग सेटअप ट्राई करते नजर आते हैं।'}
 ]};
 const warnings=scriptQualityWarnings(weak,{summary:'Siphon experiment montage'},12,'hi');
 assert.ok(warnings.some(w=>w.includes('Hook is too long')));
 assert.ok(warnings.some(w=>w.includes('clothes or people')));
});
test('Hindi people narration prefers funny fictional nicknames over stiff labels', () => {
 const weak={hook:'यहां असली पंगा शुरू है',beats:[
  {text:'एक युवती यहां बहुत सावधानी से यह प्रक्रिया करती है।'},
  {text:'महिला के सामने अचानक पूरी स्थिति बदल जाती है।'}
 ]};
 const warnings=scriptQualityWarnings(weak,{summary:'Funny prank moment'},12,'hi');
 assert.ok(warnings.some(w=>w.includes('funny nickname')));
 const punchy={hook:'बसंती ने यहां पंगा ले लिया',beats:[
  {text:'अरे बसंती ने यहां फुल पंगा ले लिया, और सीन तुरंत उल्टा पड़ गया।'},
  {text:'अब देखो, आख़िर में वही छोटा सा जुगाड़ पूरा खेल पलट देता है।'}
 ]};
 assert.ok(!scriptQualityWarnings(punchy,{summary:'Funny prank moment'},12,'hi').some(w=>w.includes('funny nickname')));
});
test('quality check rejects narration that lags behind the edit', () => {
 const weak={hook:'Watch the first trick',beats:[
  {text:'Earlier, we just saw the setup and now we are still talking about the old scene.'},
  {text:'Before this moment, the previous shot had already shown the answer.'}
 ]};
 assert.ok(scriptQualityWarnings(weak,{summary:'Fast edit'},12,'en').some(w=>w.includes('lag behind')));
});
test('quality check asks for retention structure when script is flat', () => {
 const weak={hook:'Simple process starts',beats:[
  {text:'The item is placed on the table and the process begins.'},
  {text:'The item is adjusted carefully until the process finishes.'}
 ]};
 assert.ok(scriptQualityWarnings(weak,{summary:'A process video'},12,'en').some(w=>w.includes('Retention structure')));
});
test('Hindi post-processing forces nickname and bol-chaal wording', () => {
 const styled=applyHindiNarratorStyle({
  language:'hi',
  hook:'लड़की ने प्रक्रिया शुरू की',
  beats:[
    {start:0,end:3,text:'एक युवती यह प्रक्रिया प्रदर्शित करती है।'},
    {start:3,end:8,text:'यह दृश्य परिवर्तन दिखाता है और अंत में सफलता से समाप्त होता है।'}
  ],
  metadata:{title:'Test',description:'Test #A #B #C',tags:['test']}
 }, {summary:'A girl tries a funny setup and reacts',moments:[{visible:'girl reacts to setup'}]});
 const text=[styled.hook,...styled.beats.map(b=>b.text)].join(' ');
 assert.match(text, /(बसंती|चिंकी|पिंकी|गुड्डी|बबली)/);
 assert.match(text, /(सीन|जुगाड़|अरे|भाई)/);
 assert.doesNotMatch(text, /(प्रदर्शित|प्रक्रिया|युवती|लड़की)/);
});

test('English shorts script rejects documentary voice', () => {
 const weak={hook:'This video demonstrates a liquid transfer process',beats:[
  {text:'This video demonstrates how a straw is placed inside a tall glass to move liquid.'},
  {text:'The footage depicts several people attempting the same process in sequence.'}
 ]};
 assert.ok(scriptQualityWarnings(weak,{summary:'Siphon experiment'},12,'en').some(w=>w.includes('English voiceover')));
 const punchy={hook:'This straw is hiding the trick',beats:[
  {text:'Watch the straw pull the liquid down without anyone pouring it.'},
  {text:'Now the same trick repeats, and the secret is pressure plus gravity.'}
 ]};
 assert.ok(!scriptQualityWarnings(punchy,{summary:'Siphon experiment'},12,'en').some(w=>w.includes('English voiceover')));
});

test('reference style rejects outfit inventory and camera logs', () => {
 const weak={hook:'Watch what happens next',beats:[
  {text:'A girl in a white dress is seen spraying hair while a man wearing a black shirt stands nearby.'},
  {text:'Then we see the camera shows people walking through the station.'}
 ]};
 const warnings=scriptQualityWarnings(weak,{summary:'Hair spray prank'},16,'en');
 assert.ok(warnings.some(w=>w.includes('clothes or people')));
 assert.ok(warnings.some(w=>w.includes('camera log')));
});

test('micro-short Hindi rejects passive reporting', () => {
 const weak={hook:'इस आम के अंदर कुछ अजीब है',beats:[
  {text:'पेड़ से ताज़ा आम तोड़ा गया।'},
  {text:'काटने पर अंदर से खोखला आकार निकला।'},
  {text:'चम्मच से निकाला गया अंदर का हिस्सा।'}
 ]};
 assert.ok(scriptQualityWarnings(weak,{summary:'Mango carving'},7.7,'hi').some(w=>w.includes('too formal')));
 const punchy={hook:'इस आम के अंदर ट्विस्ट है',beats:[
  {text:'ये देखो, बाहर से आम बिल्कुल नॉर्मल लगता है।'},
  {text:'लेकिन कटते ही अंदर का खोखला राज खुल जाता है।'},
  {text:'अब चम्मच से पूरा कमाल बाहर आता है।'}
 ]};
 assert.ok(!scriptQualityWarnings(punchy,{summary:'Mango carving'},7.7,'hi').some(w=>w.includes('too formal')));
});

test('continuous narration never rejects 12-word opening in a 3.4-second beat', () => {
  const s = validateScript({beats:[
    {start:0,end:3.4,text:'This is an opening with exactly twelve spoken words for the first beat.'},
    {start:3.4,end:7,text:'The camera moves to a different part of the process.'},
    {start:7,end:11.5,text:'The final demonstration reveals how the entire thing actually works.'}
  ]},11.5,'en');
  assert.equal(s.beats[0].end,3.4);
  assert.equal(s.beats[2].end,11.5);
  assert.match(s.beats[0].text,/first beat/);
});

test('more than six AI beats are merged without discarding the ending', () => {
  const source = Array.from({length:9},(_,i)=>({start:i*2,end:(i+1)*2,text:`Important spoken scene ${i+1}.`}));
  const s=validateScript({beats:source},18,'en');
  assert.equal(s.beats.length,6);
  assert.match(s.beats.at(-1).text,/scene 9/);
  assert.equal(s.beats.at(-1).end,18);
});
