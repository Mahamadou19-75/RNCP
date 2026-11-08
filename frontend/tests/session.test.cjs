'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..');
const api=fs.readFileSync(path.join(root,'api.js'),'utf8');
const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
const likes=fs.readFileSync(path.join(root,'likes.js'),'utf8');
const pages=['index.html','histoires.html','coldcases.html','dossier.html','inscription.html','connexion.html',
  'admin-connexion.html','admin-dashboard.html','theories.html','proposer-histoire.html'];
const html=Object.fromEntries(pages.map(name=>[name,fs.readFileSync(path.join(root,name),'utf8')]));
const response=(status,body)=>({status,ok:status>=200&&status<300,async json(){return body;}});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
class Element {
  constructor(tag='div'){this.tagName=tag;this.children=[];this.events=new Map();this.attributes={};this.disabled=false;this.hidden=false;this._text='';}
  set textContent(value){this._text=String(value);this.children=[];}
  get textContent(){return this._text+this.children.map(node=>node.textContent).join('');}
  set innerHTML(value){throw Error('HTML interdit');}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this._text='';this.children=nodes;}
  setAttribute(key,value){this.attributes[key]=value;}
  removeAttribute(key){delete this.attributes[key];}
  addEventListener(name,fn){this.events.set(name,[...(this.events.get(name)||[]),fn]);}
  removeEventListener(name,fn){this.events.set(name,(this.events.get(name)||[]).filter(item=>item!==fn));}
  async emit(name,extra={}){await Promise.all((this.events.get(name)||[]).map(fn=>fn({type:name,...extra})));}
  dispatchEvent(event){for(const fn of this.events.get(event.type)||[])fn(event);return true;}
  querySelector(tag){for(const child of this.children){if(child.tagName===tag)return child;const found=child.querySelector(tag);if(found)return found;}return null;}
}
async function settle(){for(let index=0;index<80;index++)await Promise.resolve();}
function mount(name='histoires.html',options={}) {
  const controls=new Element(),feedback=new Element('p'),window=new Element('window'),calls=[];
  const fallback=new Element('a');fallback.href=name==='admin-dashboard.html'?'admin-connexion.html':'connexion.html';fallback.textContent='Connexion';
  controls.append(fallback);
  const state=options.state||{authenticated:true,id:3,username:'Compte fictif',is_admin:true};
  let ended=0;
  window.addEventListener('session-ended',()=>{ended++;});
  const context=vm.createContext({AbortController,TextEncoder,setTimeout,clearTimeout,window,
    Event:class {constructor(type){this.type=type;}},
    document:{getElementById:id=>id==='session-controls'?controls:id==='session-feedback'?feedback:null,
      querySelectorAll:()=>[],querySelector:()=>null,createElement:tag=>new Element(tag)},
    async fetch(url,request){
      calls.push({url,...request});assert.equal(request.credentials,'include');
      if(url==='/api/v1/me')assert.equal(request.cache,'no-store');
      const custom=options.fetch&&await options.fetch(url,request,state,calls);
      if(custom!==undefined)return custom;
      if(url==='/api/v1/me')return state.authenticated?response(200,{status:'success',user:{id:state.id,username:state.username,is_admin:state.is_admin},csrf_token:'csrf-'+state.id}):response(401,{});
      if(url==='/api/v1/logout'){
        assert.equal(request.method,'POST');assert.equal(request.headers['X-CSRF-Token'],'csrf-'+state.id);
        assert.equal(request.body,undefined);state.authenticated=false;return response(200,{status:'success'});
      }
      if(url==='/api/v1/comments/7/like')return response(200,{status:'success',target_type:'comment',target_id:7,likes:1,liked_by_me:true});
      throw Error('Route non prévue '+url);
    }});
  vm.runInContext(api,context);vm.runInContext(app,context);
  return {controls,feedback,window,state,calls,context,get ended(){return ended;},ready:settle,
    get button(){return controls.querySelector('button');},get login(){return controls.querySelector('a');},
    writes:()=>calls.filter(call=>call.method==='POST'),click(){return this.button.emit('click');}};
}

test('les dix HTML chargent la même zone de compte une seule fois sans changer l’ordre des scripts',()=>{
  for(const name of pages){
    assert.equal((html[name].match(/id="session-controls"/g)||[]).length,1,name);
    assert.equal((html[name].match(/id="session-feedback"/g)||[]).length,1,name);
    assert.ok(html[name].indexOf('src="api.js"')<html[name].indexOf('src="app.js"'),name);
  }
});
for(const is_admin of [false,true]){
  test('compte '+(is_admin?'admin':'membre')+' reconnu sur toutes les pages sans nouvelle connexion',async()=>{
    const state={authenticated:true,id:4,username:'Utilisateur fictif',is_admin};
    for(const name of pages){
      const page=mount(name,{state});await page.ready();
      assert.match(page.controls.textContent,/Utilisateur fictif/);assert.equal(page.button.textContent,'Déconnexion');
      assert.equal(page.controls.textContent.includes('Administration'),is_admin);
      assert.equal(page.writes().length,0);assert.ok(page.calls.every(call=>call.url==='/api/v1/me'));
    }
  });
}
test('visiteur : lien de connexion sans pseudo ni déconnexion',async()=>{
  const page=mount('histoires.html',{state:{authenticated:false}});await page.ready();
  assert.equal(page.login.href,'connexion.html');assert.equal(page.button,null);assert.equal(page.ended,0);
});
test('compte suspendu : état refusé, aucun rôle inventé',async()=>{
  const page=mount('histoires.html',{fetch:()=>response(403,{})});await page.ready();
  assert.equal(page.button,null);assert.match(page.feedback.textContent,/Compte indisponible/);
});
for(const fault of ['500','network','invalid session']){
  test('lecture '+fault+' : état indisponible et nouvelle vérification sans fausse déconnexion',async()=>{
    let fail=true;
    const page=mount('dossier.html',{fetch:()=>{
      if(!fail)return;
      if(fault==='network')throw Error('offline');
      return fault==='500'?response(500,{}):response(200,{status:'success',user:{id:3,username:'Fictif',is_admin:'true'},csrf_token:'fake'});
    }});await page.ready();
    assert.equal(page.login,null);assert.equal(page.button.textContent,'Vérifier la connexion');assert.match(page.feedback.textContent,/indisponible/);
    fail=false;await page.click();assert.match(page.controls.textContent,/Administrateur/);assert.equal(page.writes().length,0);
  });
}
test('déconnexion d’une fiche : session fraîche, un POST CSRF, puis état anonyme',async()=>{
  const page=mount('dossier.html');await page.ready();await page.click();
  assert.equal(page.writes().length,1);assert.equal(page.login.href,'connexion.html');
  assert.match(page.feedback.textContent,/Vous êtes déconnecté/);assert.equal(page.ended,1);
});
test('double clic pendant la vérification de déconnexion : un seul POST',async()=>{
  const gate=deferred();let hold=false;
  const page=mount('histoires.html',{fetch:async url=>{if(hold&&url.endsWith('/me'))await gate.promise;}});
  await page.ready();hold=true;const button=page.button;
  const pending=button.emit('click');await settle();await button.emit('click');gate.resolve();await pending;
  assert.equal(page.writes().length,1);
});
test('compte changé : afficher la nouvelle identité sans déconnecter ce compte',async()=>{
  const page=mount();await page.ready();page.state.id=9;page.state.username='Autre compte';page.state.is_admin=false;
  await page.click();assert.equal(page.writes().length,0);assert.match(page.controls.textContent,/Autre compte — Membre/);
  assert.match(page.feedback.textContent,/aucune déconnexion envoyée/);assert.equal(page.ended,1);
});
for(const fault of ['403','500','network','invalid confirmation']){
  test('déconnexion '+fault+' : relecture, aucun faux succès et aucun second POST',async()=>{
    const page=mount('dossier.html',{fetch:(url,request)=>{
      if(request.method!=='POST')return;
      if(fault==='network')throw Error('offline');
      if(fault==='invalid confirmation')return response(200,{message:'incohérent'});
      return response(Number(fault),{});
    }});await page.ready();await page.click();
    assert.equal(page.writes().length,1);assert.match(page.controls.textContent,/Compte fictif/);
    assert.match(page.feedback.textContent,/non confirmée/);assert.equal(page.ended,0);
  });
}
test('réponse perdue après fin de session : état absent relu sans attribuer un faux accusé',async()=>{
  const page=mount('dossier.html',{fetch:(url,request,state)=>{if(request.method==='POST'){state.authenticated=false;throw Error('lost reply');}}});
  await page.ready();await page.click();assert.equal(page.writes().length,1);
  assert.match(page.feedback.textContent,/Session absente après vérification/);assert.equal(page.ended,1);
});
test('page quittée : une réponse tardive ne restaure pas le pseudo ; retour cache relit la session',async()=>{
  const gate=deferred();let first=true;
  const page=mount('histoires.html',{fetch:async()=>{if(first){first=false;await gate.promise;return response(200,{status:'success',user:{id:3,username:'Ancien',is_admin:true},csrf_token:'fake'});}}});
  await page.window.emit('pagehide');gate.resolve();await page.ready();assert.equal(page.controls.textContent,'');
  page.state.username='Courant';await page.window.emit('pageshow',{persisted:true});await page.ready();assert.match(page.controls.textContent,/Courant/);
  assert.doesNotMatch(page.controls.textContent,/Ancien/);
});
test('retour de focus : identité mise à jour sans stockage local',async()=>{
  const page=mount();await page.ready();page.state.id=9;page.state.username='Membre courant';page.state.is_admin=false;
  await page.window.emit('focus');assert.match(page.controls.textContent,/Membre courant — Membre/);assert.equal(page.ended,1);
});
test('retour cache pendant un logout : attendre son issue puis relire, sans restaurer une ancienne identité',async()=>{
  const gate=deferred();
  const page=mount('admin-dashboard.html',{fetch:async(url,request)=>{if(request.method==='POST')await gate.promise;}});
  await page.ready();const pending=page.click();await settle();
  await page.window.emit('pagehide');await page.window.emit('pageshow',{persisted:true});
  assert.equal(page.controls.textContent,'');assert.match(page.feedback.textContent,/Déconnexion en cours/);
  gate.resolve();await pending;await page.ready();
  assert.equal(page.login.href,'admin-connexion.html');assert.equal(page.writes().length,1);
  assert.doesNotMatch(page.controls.textContent,/Compte fictif/);
});
test('pseudo contenant du HTML : affiché comme texte, aucun élément injecté',async()=>{
  const state={authenticated:true,id:3,username:'<img src=x onerror=alert(1)>',is_admin:true};
  const page=mount('histoires.html',{state});await page.ready();
  assert.match(page.controls.textContent,/<img/);assert.equal(page.controls.querySelector('img'),null);
});
test('déconnexion : un état personnel de like déjà affiché est effacé immédiatement',async()=>{
  const page=mount('dossier.html');await page.ready();vm.runInContext(likes,page.context);
  const control=vm.runInContext("createLikeControl('comment',7,1)",page.context);await page.ready();
  const action=control.node.children.find(node=>node.tagName==='button');assert.equal(action.attributes['aria-pressed'],'true');
  await page.click();assert.equal(action.disabled,true);assert.equal(action.attributes['aria-pressed'],undefined);
});
