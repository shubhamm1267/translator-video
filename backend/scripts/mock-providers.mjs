// Used ONLY by the integration test: provider requests are mocked locally.
import { readFileSync, appendFileSync } from 'node:fs';
const realFetch = globalThis.fetch;
const json = obj => new Response(JSON.stringify(obj), { status: 200, headers: {'content-type':'application/json'} });
globalThis.fetch = async (input, init={}) => {
  const url = String(input);
  if (url.endsWith('/upload/v1beta/files')) { if(process.env.MOCK_TRACE) appendFileSync(process.env.MOCK_TRACE,'UPLOAD\n'); }
  if (url.endsWith('/upload/v1beta/files')) return new Response('{}',{status:200,headers:{'x-goog-upload-url':'https://mock-upload.invalid/file'}});
  if (url.includes('mock-upload.invalid')) return json({file:{name:'files/fixture',uri:'mock://fixture'}});
  if (url.endsWith('/v1beta/files/fixture')) {
    if (init.method === 'DELETE') return new Response(null,{status:204});
    return json({name:'files/fixture',uri:'mock://fixture',state:'ACTIVE'});
  }
  if (url.endsWith('/v1beta/interactions')) {
    const req=JSON.parse(init.body);
    if (!['gemini-3.5-flash-lite','gemini-3.8-flash','gemini-3.1-flash-lite'].includes(req.model)) throw new Error('Bad model '+req.model);
    const analysis = req.input.some(x=>x.type==='video' && x.uri==='mock://fixture');
    if (process.env.MOCK_TRACE) appendFileSync(process.env.MOCK_TRACE, analysis ? 'ANALYZE\n' : 'STORY\n');
    const variation = /REVISION 1|REVISION 2|REVISION 3/.test(req.input?.[0]?.text || '');
    const answer = analysis ? {
      summary:'A person adjusts a small object, moves between stages and reveals a finished product',
      subject:'unidentified mechanism', subjectConfidence:'low',
      format:'process', visualContrast:'unexpected tool in the middle',
      potentialPayoff:'finished product shown at end',
      moments:[{time:0,visible:'tool appears',certainty:'clear'},
        {time:3,visible:'material is handled',certainty:'clear'},
        {time:6,visible:'visible shaping step',certainty:'clear'},
        {time:8.4,visible:'finished result shown',certainty:'clear'}]
    } : variation ? {
      summary:'An original visual demonstration', hook:'A surprising new angle',
      beats:[{start:0,end:3,text:'Why does this unusual little tool matter?'},
        {start:3,end:6,text:'One careful movement changes the material.'},
        {start:6,end:9,text:'The finished result reveals the trick.'}],
      metadata:{title:'Another real reveal',description:'An alternative description. #Shorts',tags:['demo','variation']}
    } : {
      summary:'An original visual demonstration', hook:'What is this unusual tool for?',
      beats:[{start:0,end:3,text:'This simple tool hides a surprising purpose.'},
        {start:3,end:6,text:'The material starts changing before your eyes.'},
        {start:6,end:9,text:'Watch the finished result appear right here.'}],
      metadata:{title:'What this tool really does',description:'An interesting visible process. #Shorts',tags:['demo','shorts']}
    };
    return json({status:'completed',steps:[{type:'model_output',content:[{type:'text',text:JSON.stringify(answer)}]}]});
  }
  if(url.endsWith('/tts/bytes')) {
    let take=1;
    if (process.env.MOCK_TRACE) {
      const {readFileSync:read}=await import('node:fs');
      const t=read(process.env.MOCK_TRACE,'utf8');
      take=t.split('TTS').length;
      appendFileSync(process.env.MOCK_TRACE,'TTS\n');
    }
    const voice=take>=2 && process.env.MOCK_CARTESIA_WAV_PATH_2
      ? process.env.MOCK_CARTESIA_WAV_PATH_2 : process.env.MOCK_CARTESIA_WAV_PATH;
    return new Response(readFileSync(voice),{status:200,headers:{'content-type':'audio/wav'}});
  }
  if(url.startsWith('https://api.cartesia.ai/voices?')) {
    const lang=new URL(url).searchParams.get('language');
    return json({data:[{id:lang==='hi'?'voice-hindi':'voice-english',name:lang==='hi'?'Hindi Native':'English Native',language:lang,accents:[{locale:lang==='hi'?'hi-IN':'en-US',is_native:true}]}],has_more:false});
  }
  return realFetch(input,init);
};
