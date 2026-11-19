/* PlateTimer voice-command parser. Pure, browser + Node compatible; no audio, auth or network dependencies. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;root.PlateVoiceCommand=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const LANGUAGES=Object.freeze({'it-IT':'it','fr-CH':'fr','de-CH':'de'});
const WORDS={
 it:['zero','uno','due','tre','quattro','cinque','sei','sette','otto','nove','dieci','undici','dodici','tredici','quattordici','quindici','sedici','diciassette','diciotto','diciannove'],
 fr:['zéro','un','deux','trois','quatre','cinq','six','sept','huit','neuf','dix','onze','douze','treize','quatorze','quinze','seize','dix-sept','dix-huit','dix-neuf'],
 de:['null','eins','zwei','drei','vier','fünf','sechs','sieben','acht','neun','zehn','elf','zwölf','dreizehn','vierzehn','fünfzehn','sechzehn','siebzehn','achtzehn','neunzehn']
};
const IT_TENS=['','','venti','trenta','quaranta','cinquanta','sessanta','settanta','ottanta','novanta'];
const FR_TENS=['','','vingt','trente','quarante','cinquante','soixante','septante','huitante','nonante'];
const DE_TENS=['','','zwanzig','dreißig','vierzig','fünfzig','sechzig','siebzig','achtzig','neunzig'];
function clean(s){return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/ß/g,'ss').replace(/[’']/g,' ').replace(/[-–]/g,' ').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');}
function variants(lang,n){
 if(n<20)return [WORDS[lang][n]];
 const t=Math.floor(n/10),u=n%10;
 if(lang==='it'){const stem=IT_TENS[t];return [u===0?stem:(u===1||u===8?stem.slice(0,-1):stem)+WORDS.it[u]];}
 if(lang==='de'){const stem=DE_TENS[t];return [u===0?stem:(u===1?'ein':WORDS.de[u])+'und'+stem];}
 if(u===0)return [FR_TENS[t]];
 if(t===8)return ['huitante '+WORDS.fr[u],'quatre vingt '+WORDS.fr[u]];
 if(t===9)return ['nonante '+WORDS.fr[u],'quatre vingt '+WORDS.fr[10+u]];
 if(t===7)return ['septante '+WORDS.fr[u],'soixante '+WORDS.fr[10+u]];
 if(t===6&&u>0)return [u===1?'soixante et un':'soixante '+WORDS.fr[u]];
 return [FR_TENS[t]+(u===1?' et ':' ')+WORDS.fr[u]];
}
const aliases={};
for(const lang of Object.keys(WORDS)){
 const table=new Map();
 for(let n=0;n<=99;n++)for(const v of variants(lang,n))table.set(clean(v),String(n));
 if(lang==='it')table.set('un','1');
 if(lang==='de'){table.set('ein','1');table.set('eine','1');table.set('einen','1');}
 if(lang==='fr'){table.set('quatre vingts','80');table.set('quatre vingt','80');}
 aliases[lang]=Array.from(table.entries()).sort((a,b)=>b[0].length-a[0].length);
}
function numberize(text,lang){
 let norm=' '+clean(text)+' ';
 for(const [word,value] of aliases[lang]){
  const pattern=new RegExp(' '+word+' ','g');
  norm=norm.replace(pattern,' '+value+' ');
 }
 return norm.trim().replace(/\s+/g,' ');
}
const COMMANDS={it:{table:'tavolo',minute:'minut[io]?',filler:['per','a','alla','al','in','reparto','e']},fr:{table:'table',minute:'minutes?',filler:['pour','a','au','aux','en','service','et']},de:{table:'tisch',minute:'minuten?',filler:['fur','an','in','abteilung','und']}};
function parse(text,languageCode,departments,ownDepartmentId){
 const lang=LANGUAGES[languageCode];
 if(!lang)return {ok:false,code:'INVALID_LANGUAGE'};
 if(typeof text!=='string'||text.length>500)return {ok:false,code:'INVALID_TEXT'};
 const normalized=numberize(text,lang),spec=COMMANDS[lang];
 const tableMatches=[...normalized.matchAll(new RegExp('(?:^| )'+spec.table+' (\\d{1,4})(?= |$)','g'))];
 const durMatches=[...normalized.matchAll(new RegExp('(?:^| )(\\d{1,3}) '+spec.minute+'s?(?= |$)','g'))];
 if(tableMatches.length!==1||durMatches.length!==1)return {ok:false,code:'MISSING_OR_AMBIGUOUS_FIELDS'};
 const tableNumber=String(Number(tableMatches[0][1])),durationMinutes=Number(durMatches[0][1]);
 if(Number(tableNumber)<1||Number(tableNumber)>9999||!Number.isInteger(durationMinutes)||durationMinutes<1||durationMinutes>99)return {ok:false,code:'OUT_OF_RANGE'};
 let remainder=normalized.replace(tableMatches[0][0],' ').replace(durMatches[0][0],' ');
 let dests=[];
 const active=Array.isArray(departments)?departments.filter(d=>d&&d.active!==false&&typeof d.id==='string'&&typeof d.name==='string'):[];
 // Longest department name first; match whole normalized word boundaries.
 for(const d of active.sort((a,b)=>b.name.length-a.name.length)){
  const forms=[d.name,...(Array.isArray(d.voiceAliases)?d.voiceAliases:[])].map(clean).filter(Boolean);
  for(const form of forms){
   const padded=' '+remainder+' ';
   if(padded.includes(' '+form+' ')){
    dests.push(d.id);remainder=padded.replace(' '+form+' ',' ').trim();break;
   }
  }
 }
 const ignored=new Set([spec.table,...spec.filler,'min','minuti','minute','minutes','minuten']);
 const extras=remainder.split(/\s+/).filter(w=>w&&!ignored.has(w));
 if(extras.length)return {ok:false,code:'UNKNOWN_TERMS',unknown:extras.slice(0,6)};
 if(!dests.length)dests=[ownDepartmentId];
 if(typeof ownDepartmentId!=='string'||!active.some(d=>d.id===ownDepartmentId))return {ok:false,code:'INVALID_OWN_DEPARTMENT'};
 if(!dests.includes(ownDepartmentId))dests.push(ownDepartmentId);
 return {ok:true,tableNumber,durationMinutes,departmentIds:[...new Set(dests)],languageCode,transcription:text};
}
return Object.freeze({parse,clean,numberize,LANGUAGES});
});
