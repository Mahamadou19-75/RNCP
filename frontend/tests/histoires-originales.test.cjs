'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const frontend = path.join(__dirname, '..');
const catalog = JSON.parse(fs.readFileSync(path.join(frontend,'../tools/fixtures/dossiers_historiques.json'),'utf8'));
const illustratedFiles = {
  'golden-state-killer':'golden-state-killer.png', 'chris-watts':'chris-watts.png',
  'michelle-carter':'michelle-carter.png', 'anthonioz':'mystere-anthonioz.png',
  'noirval':'inconnue-noirval.png', 'manoir-de-l-ombre':'manoir-ombre.png'
};
const rows = process.env.HISTOIRES_API_FIXTURE ? JSON.parse(fs.readFileSync(process.env.HISTOIRES_API_FIXTURE,'utf8')) : catalog.stories;
const api = fs.readFileSync(path.join(frontend,'api.js'),'utf8');
const app = fs.readFileSync(path.join(frontend,'app.js'),'utf8');
class Element {
  constructor(tag='div') {
    this.tagName=tag; this.children=[]; this.dataset={}; this.style={}; this.attributes={}; this.events=new Map();
    this.value='';this.hidden=false;this.disabled=false;this.className='';this._text='';
    Object.defineProperty(this,'innerHTML',{set(){throw Error('HTML injection forbidden');},get(){throw Error('HTML parsing forbidden');}});
  }
  set textContent(value){this._text=String(value);this.children=[];}
  get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}
  append(...items){this.children.push(...items);}
  replaceChildren(...items){this._text='';this.children=items;}
  setAttribute(k,v){this.attributes[k]=v;}
  addEventListener(k,v){this.events.set(k,v);}
  querySelector(selector){for(const c of this.children){if(selector===c.tagName)return c;const found=c.querySelector(selector);if(found)return found;}return null;}
}
function mount({type,slug,stories=rows}={}){
  const nodes=new Map(),calls=[],mounted=[];
  const list=type?new Element():null;
  if(list){
    list.dataset.storyType=type;nodes.set('stories-feedback',new Element());
    const filename={resolved:'histoires.html',coldcase:'coldcases.html',all:'index.html'}[type];
    const html=fs.readFileSync(path.join(frontend,filename),'utf8');
    for(const id of ['recherche','aucun-resultat']){
      const tag=html.match(new RegExp('<[^>]+\\bid="'+id+'"[^>]*>'));
      if(tag){const node=new Element();node.hidden=/\bhidden\b/.test(tag[0]);nodes.set(id,node);}
    }
  }
  if(slug){for(const id of ['detail-titre','detail-resume','detail-categorie','detail-contenu','detail-feedback','detail-image','retour-dossier'])nodes.set(id,new Element());nodes.get('detail-titre').parentElement=new Element();}
  const document={baseURI:'http://portfolio.test/',getElementById:id=>nodes.get(id)||null,
    querySelector:s=>s==='[data-story-type]'?list:null,querySelectorAll:()=>[],createElement:t=>new Element(t)};
  const context=vm.createContext({document,URL,URLSearchParams,AbortController,TextEncoder,setTimeout,clearTimeout,
    location:{search:slug?'?slug='+encodeURIComponent(slug):''},
    mountStoryComments:id=>mounted.push(['comments',id]),mountStoryLike:row=>mounted.push(['likes',row.id]),
    async fetch(url,options){assert.equal(options.method||'GET','GET');calls.push(url);
      if(url==='/api/v1/stories')return {status:200,ok:true,json:async()=>stories};
      const prefix='/api/v1/stories/slug/';assert.ok(url.startsWith(prefix));
      const row=stories.find(r=>r.slug===decodeURIComponent(url.slice(prefix.length)));assert.ok(row);
      return {status:200,ok:true,json:async()=>row};
    },WebSocket(){throw Error('Network forbidden');},XMLHttpRequest(){throw Error('Network forbidden');}});
  vm.runInContext(api,context,{filename:'frontend/api.js',timeout:1000});
  vm.runInContext(app,context,{filename:'frontend/app.js',timeout:1000});
  return {nodes,list,calls,mounted};
}
async function settle(){for(let i=0;i<40;i++)await Promise.resolve();}
test('API snapshot and catalog have the same six exact titles summaries and complete contents',()=>{
  assert.equal(rows.length,6);
  for(const row of rows){const original=catalog.stories.find(s=>s.id===row.id);assert.ok(original);
    for(const key of ['slug','title','summary','content','category_id','image_url'])assert.equal(row[key],original[key]);
    assert.equal(crypto.createHash('sha256').update(original.content_html).digest('hex'),original.content_html_sha256);
  }
});
for(const [type,category] of [['resolved',1],['coldcase',2]]){
  test(type+': exactly three original titles summaries slugs and explicitly associated illustrations',async()=>{
    const p=mount({type,stories:rows.slice().reverse()});await settle();const expected=catalog.stories.filter(r=>r.category_id===category);
    assert.equal(p.list.children.length,3);assert.equal(expected.length,3);
    p.list.children.forEach((card,i)=>{assert.equal(card.querySelector('h3').textContent,expected[i].title);
      assert.ok(card.textContent.includes(expected[i].summary));assert.equal(card.querySelector('a').href,'dossier.html?slug='+encodeURIComponent(expected[i].slug));
      assert.equal(card.querySelector('img').src,'images/'+illustratedFiles[expected[i].slug]);
      assert.equal(card.querySelector('figcaption').textContent,'Illustration générée par IA');
    });assert.deepEqual(p.calls,['/api/v1/stories']);
  });
}
test('home keeps the first three API stories in their received order without mutating the response',async()=>{
  const stories=Object.freeze(rows.slice().reverse());const before=JSON.stringify(stories);
  const p=mount({type:'all',stories});await settle();
  assert.deepEqual(p.list.children.map(card=>card.querySelector('h3').textContent),stories.slice(0,3).map(s=>s.title));
  assert.equal(JSON.stringify(stories),before);
});

for(const [type,category,filename] of [['resolved',1,'histoires.html'],['coldcase',2,'coldcases.html']]){
  test(type+': actual HTML has one labelled search and one initially hidden empty state',()=>{
    const html=fs.readFileSync(path.join(frontend,filename),'utf8');
    assert.equal((html.match(/id="recherche"/g)||[]).length,1);
    assert.match(html,/<label\s+for="recherche">[^<]+<\/label>/);
    assert.match(html,/<input\b(?=[^>]*id="recherche")(?=[^>]*type="search")[^>]*>/);
    assert.equal((html.match(/id="aucun-resultat"/g)||[]).length,1);
    assert.match(html,/<p\b(?=[^>]*id="aucun-resultat")(?=[^>]*\bhidden\b)[^>]*>Aucun dossier ne correspond à cette recherche\.<\/p>/);
  });
  test(type+': title and summary search, empty state and reset preserve editorial order',async()=>{
    const stories=Object.freeze([rows[4],rows[2],rows[0],rows[5],rows[1],rows[3]]);
    const p=mount({type,stories});await settle();
    const search=p.nodes.get('recherche'),empty=p.nodes.get('aucun-resultat');
    assert.ok(search);assert.ok(empty);assert.equal(search.disabled,false);assert.equal(empty.hidden,true);
    const expected=catalog.stories.filter(s=>s.category_id===category);
    function searchFor(value){search.value=value;search.events.get('input')();}
    searchFor('  '+expected[1].title.toLocaleUpperCase('fr')+'  ');
    assert.deepEqual(p.list.children.map(c=>c.querySelector('h3').textContent),[expected[1].title]);
    assert.equal(empty.hidden,true);
    // A phrase from the actual original summary that does not occur in the title.
    const summary=expected[0].summary;
    assert.ok(!expected[0].title.toLocaleLowerCase('fr').includes(summary.toLocaleLowerCase('fr')));
    searchFor(summary.toLocaleUpperCase('fr'));
    assert.deepEqual(p.list.children.map(c=>c.querySelector('h3').textContent),[expected[0].title]);
    searchFor('aucun-resultat-lot6h16-4');assert.equal(p.list.children.length,0);assert.equal(empty.hidden,false);
    searchFor('   ');assert.equal(empty.hidden,true);
    assert.deepEqual(p.list.children.map(c=>c.querySelector('h3').textContent),expected.map(s=>s.title));
    assert.deepEqual(p.calls,['/api/v1/stories']);
  });
  test(type+': reversed API rows and unrecognised slugs preserve input and new-story relative order',async()=>{
    const first={...catalog.stories.find(s=>s.category_id===category),id:901,slug:'nouveau-z',title:'Autre Z'};
    const second={...first,id:902,slug:'nouveau-a',title:'Autre A'};
    const stories=Object.freeze([first,...rows.slice().reverse(),second]);const before=JSON.stringify(stories);
    const p=mount({type,stories});await settle();
    assert.deepEqual(p.list.children.map(c=>c.querySelector('a').href),
      [...catalog.stories.filter(s=>s.category_id===category),first,second].map(s=>'dossier.html?slug='+encodeURIComponent(s.slug)));
    assert.equal(JSON.stringify(stories),before);
  });
}
for(const original of catalog.stories){
  test(original.legacy_id+': complete unchanged chapters and article with real SQL associations',async()=>{
    const p=mount({slug:original.slug});await settle();
    assert.equal(p.nodes.get('detail-titre').textContent,original.title);assert.equal(p.nodes.get('detail-resume').textContent,original.summary);
    const lines=p.nodes.get('detail-contenu').children.map(n=>n.textContent);assert.deepEqual(lines,original.content.split(/\r?\n/));
    for(const block of original.blocks)assert.ok(lines.includes(block.text));
    const nodes=p.nodes.get('detail-contenu').children;
    const headings=original.blocks.filter(b=>b.tag==='h4').map(b=>b.text);
    assert.deepEqual(nodes.filter(n=>n.tagName==='h2').map(n=>n.textContent),headings);
    for(const node of nodes){
      assert.equal(node.tagName,headings.includes(node.textContent)?'h2':'p');
      if(node.tagName==='h2')assert.equal(node.className,'story-subheading');
    }
    assert.deepEqual(p.mounted,[['comments',original.id],['likes',original.id]]);
    assert.equal(p.nodes.get('retour-dossier').href,original.category_id===1?'histoires.html':'coldcases.html');
    assert.equal(p.nodes.get('detail-image').querySelector('img').src,'images/'+illustratedFiles[original.slug]);
    assert.match(p.nodes.get('detail-image').querySelector('figcaption').textContent,/sans valeur de photographie ou de preuve authentique/);
    assert.deepEqual(p.calls,['/api/v1/stories/slug/'+original.slug]);
  });
}

test('unknown slug never promotes copied historical headings or interprets submitted HTML',async()=>{
  const original=catalog.stories[0];
  const row={...original,id:901,slug:'autre-dossier',content:original.blocks[0].text+'\n\n<h2>Texte envoyé</h2>'};
  const p=mount({slug:row.slug,stories:[row]});await settle();
  const nodes=p.nodes.get('detail-contenu').children;
  assert.deepEqual(nodes.map(n=>n.textContent),row.content.split(/\r?\n/));
  assert.ok(nodes.every(n=>n.tagName==='p'));
});

test('historical slug recognises only exact headings from its own approved article',async()=>{
  const original=catalog.stories[0],own=original.blocks[0].text;
  const foreign=catalog.stories[3].blocks.find(b=>b.tag==='h4'&&!original.blocks.some(o=>o.text===b.text)).text;
  const row={...original,content:[own,own+' ',foreign,'Texte de contrôle'].join('\n')};
  const p=mount({slug:row.slug,stories:[row]});await settle();
  const nodes=p.nodes.get('detail-contenu').children;
  assert.deepEqual(nodes.map(n=>n.textContent),row.content.split('\n'));
  assert.deepEqual(nodes.map(n=>n.tagName),['h2','p','p','p']);
});
