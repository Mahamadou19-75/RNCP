'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..');
const sources=Object.fromEntries(['api.js','likes.js','comments.js','dossier.html','styles.css'].map(name=>[name,fs.readFileSync(path.join(root,name),'utf8')]));
const response=(status,body)=>({status,ok:status>=200&&status<300,async json(){return body;}});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
class Element{
  constructor(tag='div'){this.tagName=tag;this.children=[];this.dataset={};this.attributes={};this.events=new Map();this.style={};this._text='';this.value='';this.hidden=false;this.disabled=false;
    Object.defineProperty(this,'innerHTML',{get(){throw Error('HTML interdit');},set(){throw Error('HTML interdit');}});}
  set textContent(value){this._text=String(value);this.children=[];}
  get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this._text='';this.children=children;}
  setAttribute(key,value){this.attributes[key]=value;}
  removeAttribute(key){delete this.attributes[key];}
  addEventListener(name,fn){this.events.set(name,[...(this.events.get(name)||[]),fn]);}
  async emit(name,extra={}){await Promise.all((this.events.get(name)||[]).map(fn=>fn({preventDefault(){},...extra})));}
  querySelectorAll(selector){return this.children.flatMap(c=>[...((selector===c.tagName||selector==='.'+c.className)?[c]:[]),...c.querySelectorAll(selector)]);}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  focus(){this.focused=true;}
}
async function settle(){for(let i=0;i<40;i++)await Promise.resolve();}
function mount(kind='story',options={}){
  const calls=[],ids=new Map(),window=new Element(),timers=new Map();let timerId=0;
  const state={likes:options.initial===undefined?2:options.initial,liked_by_me:!!options.owned};
  let userId=5;
  if(options.comments){for(const id of ['story-comments','comments-list','comments-refresh','comments-feedback','comment-form','comment-text','comment-send','comment-feedback','report-form','report-target','report-reason','report-send','report-cancel','report-feedback'])ids.set(id,new Element());ids.get('report-form').hidden=true;}
  const context=vm.createContext({AbortController,TextEncoder,window,
    setTimeout:options.fakeTimers?fn=>{timers.set(++timerId,fn);return timerId;}:setTimeout,
    clearTimeout:options.fakeTimers?id=>timers.delete(id):clearTimeout,
    document:{getElementById:id=>ids.get(id)||null,createElement:tag=>new Element(tag)},
    async fetch(url,request){
      const method=request.method||'GET';assert.equal(request.credentials,'include');
      assert.ok(['/api/v1/me','/api/v1/votes/17','/api/v1/comments/31/like','/api/v1/stories/17/comments','/api/v1/comments/31/report'].includes(url),'Route inattendue '+url);
      calls.push({url,...request,method});const special=options.fetch&&await options.fetch(url,request,calls,state);if(special!==undefined)return special;
      if(url==='/api/v1/me')return response(200,{user:{id:userId},csrf_token:'csrf-isole-'+userId});
      if(url.endsWith('/comments'))return response(200,[{id:31,story_id:17,user_id:5,username:'Fictif',text:'Texte',created_at:null,likes:state.likes,likes_compatible:true}]);
      if(url.endsWith('/report'))return response(201,{status:'success',report:{id:4,type:'comment',target_id:'31'}});
      const target=url.endsWith('/17')?'story':'comment',id=target==='story'?17:31;
      const payload=()=>({status:'success',target_type:target,target_id:id,likes:state.likes,liked_by_me:state.liked_by_me});
      if(method==='GET')return response(200,payload());
      if(method==='DELETE'){const changed=state.liked_by_me;if(changed)state.likes--;state.liked_by_me=false;return response(200,{...payload(),changed});}
      if(state.liked_by_me)return response(409,{message:'Déjà aimé'});
      state.liked_by_me=true;state.likes++;
      return target==='story'?response(201,{message:'Vote pris en compte !',votes:state.likes}):response(200,{status:'success',comment:{id:31,story_id:17,likes:state.likes,likes_compatible:true}});
    }
  });
  vm.runInContext(sources['api.js'],context);vm.runInContext(sources['likes.js'],context);
  let control;
  if(options.comments){vm.runInContext(sources['comments.js'],context);vm.runInContext('mountStoryComments(17)',context);}
  else control=vm.runInContext('createLikeControl('+JSON.stringify(kind)+','+(kind==='story'?17:31)+','+JSON.stringify(options.initial===undefined?2:options.initial)+', {compatible:'+String(options.compatible!==false)+'})',context);
  return {context,state,calls,window,timers,get:id=>ids.get(id),control,
    get node(){return control?control.node:ids.get('comments-list').querySelector('.like-control');},
    get button(){return this.node.querySelectorAll('button')[0];},get verify(){return this.node.querySelectorAll('button')[1];},
    get feedback(){return this.node.querySelector('p').textContent;},get count(){return this.node.querySelector('span').textContent;},
    writes:()=>calls.filter(c=>c.method==='POST'||c.method==='DELETE'),ready:settle,
    changeUser(id){userId=id;},click(){return this.button.emit('click');},check(){return this.verify.emit('click');}
  };
}

test('fiche et CSS : module avant app.js, contrôle natif, aria-pressed et focus sans dashboard',()=>{
  const html=sources['dossier.html'];assert.match(html,/id="story-like"/);
  assert.ok(html.indexOf('src="api.js"')<html.indexOf('src="likes.js"'));
  assert.ok(html.indexOf('src="likes.js"')<html.indexOf('src="comments.js"'));
  assert.match(sources['styles.css'],/\.like-control button:focus-visible/);
});
for(const kind of ['story','comment']){
  test(kind+': lecture personnelle, ajout, retrait et rechargement depuis le serveur',async()=>{
    const page=mount(kind);await page.ready();assert.equal(page.count,'2 J’aime');assert.equal(page.button.attributes['aria-pressed'],'false');
    await page.click();assert.equal(page.count,'3 J’aime');assert.equal(page.button.attributes['aria-pressed'],'true');assert.equal(page.feedback,'J’aime ajouté.');
    await page.click();assert.equal(page.count,'2 J’aime');assert.equal(page.button.attributes['aria-pressed'],'false');assert.equal(page.writes().length,2);assert.equal(page.feedback,'J’aime retiré.');
    assert.deepEqual(page.writes().map(c=>c.method),['POST','DELETE']);
    for(const call of page.writes()){assert.equal(call.headers['X-CSRF-Token'],'csrf-isole-5');assert.equal(call.body,undefined);}
    page.state.liked_by_me=true;page.state.likes=7;await page.check();assert.equal(page.count,'7 J’aime');assert.match(page.button.textContent,/Retirer/);
    page.control.dispose();assert.equal(page.button.attributes['aria-pressed'],undefined);assert.equal(page.count,'7 J’aime');
  });
  test(kind+': un visiteur voit le compte public sans écriture',async()=>{
    const page=mount(kind,{fetch:url=>url.endsWith('/me')?response(401,{}):undefined});await page.ready();
    assert.equal(page.count,'2 J’aime');assert.equal(page.button.disabled,true);assert.match(page.feedback,/Connectez-vous/);await page.click();assert.equal(page.writes().length,0);
  });
  test(kind+': un état initial déjà aimé propose le retrait après chargement',async()=>{
    const page=mount(kind,{owned:true});await page.ready();assert.equal(page.button.attributes['aria-pressed'],'true');await page.click();assert.equal(page.writes()[0].method,'DELETE');
  });
  for(const stage of ['session','action','relecture']){
    test(kind+': double clic bloqué pendant '+stage,async()=>{
      const gate=deferred();let hold=false;
      const page=mount(kind,{fetch:async(url,request,calls)=>{
        if(hold&&((stage==='session'&&url.endsWith('/me'))||(stage==='action'&&request.method==='POST')||(stage==='relecture'&&calls.some(c=>c.method==='POST'))))await gate.promise;
      }});await page.ready();hold=true;const pending=page.click();await settle();await page.click();
      assert.equal(page.button.disabled,true);assert.ok(page.writes().length<=1);gate.resolve();await pending;assert.equal(page.writes().length,1);
    });
  }
  for(const status of [401,403,404]){
    test(kind+': refus '+status+' à l’action sans faux succès',async()=>{
      const page=mount(kind,{fetch:(url,req)=>req.method==='POST'?response(status,{}):undefined});await page.ready();await page.click();
      assert.doesNotMatch(page.feedback,/J’aime (ajouté|retiré)\./);assert.equal(page.button.disabled,true);assert.equal(page.state.liked_by_me,false);
    });
  }
  test(kind+': compte changé entre affichage et clic, aucune écriture',async()=>{
    const page=mount(kind);await page.ready();page.changeUser(9);await page.click();assert.equal(page.writes().length,0);assert.match(page.feedback,/Compte modifié/);
  });
  test(kind+': état changé dans un autre onglet satisfait déjà l’intention',async()=>{
    const page=mount(kind);await page.ready();page.state.liked_by_me=true;page.state.likes=3;await page.click();assert.equal(page.writes().length,0);assert.equal(page.count,'3 J’aime');
  });
  test(kind+': doublon 409 relu sans répétition automatique',async()=>{
    const page=mount(kind,{fetch:(url,req,calls,state)=>{if(req.method==='POST'){state.liked_by_me=true;state.likes=3;return response(409,{});}}});await page.ready();await page.click();
    assert.equal(page.writes().length,1);assert.equal(page.feedback,'Vos J’aime ont changé. Compteur actualisé.');assert.equal(page.button.attributes['aria-pressed'],'true');
  });
  for(const fault of ['réseau','500','JSON illisible','mauvaise cible','timeout']){
    test(kind+': '+fault+' après POST laisse le résultat incertain, sans renvoi',async()=>{
      const page=mount(kind,{fakeTimers:fault==='timeout',fetch:(url,req)=>{
        if(req.method!=='POST')return;
        if(fault==='réseau')throw Error('offline');if(fault==='500')return response(500,{});
        if(fault==='JSON illisible')return {...response(200,{}),json(){throw new SyntaxError();}};
        if(fault==='timeout')return new Promise((_,reject)=>req.signal.addEventListener('abort',()=>reject(Error('abort'))));
        return kind==='story'?response(201,{message:'ok',votes:-1}):response(200,{status:'success',comment:{id:999,likes:3}});
      }});await page.ready();const pending=page.click();await settle();if(fault==='timeout')for(const fn of page.timers.values())fn();await pending;
      assert.match(page.feedback,/Résultat incertain/);assert.equal(page.button.disabled,true);await page.click();await page.check();assert.equal(page.writes().length,1);assert.equal(page.button.disabled,true);
    });
  }
  test(kind+': ajout confirmé puis panne de relecture conserve la confirmation',async()=>{
    let wrote=false;
    const page=mount(kind,{fetch:(url,req)=>{if(req.method==='POST'){wrote=true;return undefined;}if(wrote&&url!='/api/v1/me')throw Error('offline');}});await page.ready();await page.click();
    assert.match(page.feedback,/^J’aime ajouté\. Compteur indisponible/);assert.equal(page.writes().length,1);assert.equal(page.button.disabled,true);
  });
  test(kind+': compteur manquant jamais remplacé par zéro',async()=>{
    const page=mount(kind,{initial:null,fetch:url=>url.endsWith('/me')?response(401,{}):undefined});await page.ready();assert.match(page.count,/indisponible/);assert.doesNotMatch(page.count,/0 J’aime/);
  });
  test(kind+': retrait confirmé puis compteur indisponible ne perd pas la confirmation',async()=>{
    let wrote=false;
    const page=mount(kind,{owned:true,fetch:(url,req)=>{
      if(req.method==='DELETE'){wrote=true;return;}
      if(wrote&&url!='/api/v1/me')throw Error('offline');
    }});
    await page.ready();await page.click();
    assert.match(page.feedback,/^J’aime retiré\. Compteur indisponible/);
    assert.equal(page.writes().length,1);assert.equal(page.verify.disabled,false);
  });
  test(kind+': retrait incertain interdit un deuxième DELETE même après actualisation',async()=>{
    const page=mount(kind,{owned:true,fetch:(url,req)=>req.method==='DELETE'?response(500,{}):undefined});
    await page.ready();await page.click();
    assert.match(page.feedback,/Résultat incertain/);
    assert.doesNotMatch(page.feedback,/J’aime (ajouté|retiré)\./);
    await page.click();await page.check();await page.click();
    assert.equal(page.writes().length,1);assert.equal(page.button.disabled,true);
    assert.match(page.feedback,/L’envoi précédent reste incertain/);
  });
  test(kind+': modification concurrente après confirmation utilise le dernier compteur',async()=>{
    const page=mount(kind,{fetch:(url,req,calls,state)=>{
      if((req.method||'GET')==='GET'&&url!='/api/v1/me'&&calls.some(c=>c.method==='POST')){
        state.liked_by_me=false;state.likes=2;
      }
    }});
    await page.ready();await page.click();
    assert.equal(page.feedback,'Vos J’aime ont changé. Compteur actualisé.');
    assert.equal(page.count,'2 J’aime');assert.equal(page.button.attributes['aria-pressed'],'false');
    assert.equal(page.writes().length,1);
  });
  for(const user of [{id:1,is_admin:true},{id:2,is_admin:false},{id:3,is_admin:false}]){
    test(kind+': contrat de session permanent id '+user.id+' sans identifiant privé',async()=>{
      const page=mount(kind,{fetch:url=>url.endsWith('/me')?response(200,{user,csrf_token:'session-simulee-'+user.id}):undefined});
      await page.ready();await page.click();assert.equal(page.feedback,'J’aime ajouté.');
      await page.click();assert.equal(page.feedback,'J’aime retiré.');
      assert.ok(page.writes().every(call=>call.headers['X-CSRF-Token']==='session-simulee-'+user.id));
    });
  }
  for(const invalid of [{target_type:'other'},{target_id:999},{likes:'2'},{likes:-1},{liked_by_me:'yes'}]){
    test(kind+': état privé incohérent '+JSON.stringify(invalid)+' bloque l’action',async()=>{
      const page=mount(kind,{fetch:url=>url==='/api/v1/me'?undefined:response(200,{status:'success',target_type:kind,target_id:kind==='story'?17:31,likes:2,liked_by_me:false,...invalid})});await page.ready();
      assert.equal(page.button.disabled,true);assert.match(page.feedback,/indisponible/);assert.equal(page.writes().length,0);
    });
  }
  test(kind+': réponse tardive après destruction ignorée',async()=>{
    const gate=deferred();const page=mount(kind,{fetch:async()=>{await gate.promise;return response(200,{user:{id:5},csrf_token:'fake'});}});
    page.control.dispose();gate.resolve();await page.ready();assert.equal(page.button.disabled,true);assert.equal(page.button.attributes['aria-pressed'],undefined);
  });
}
test('compteur historique commentaire conservé et contrôles bloqués sans requête',async()=>{
  const page=mount('comment',{initial:8,compatible:false});await page.ready();assert.equal(page.count,'8 mentions historiques');assert.equal(page.button.disabled,true);assert.equal(page.calls.length,0);
});
test('historique modifié après chargement : refus sans écriture',async()=>{
  let incompatible=false;const page=mount('comment',{fetch:url=>incompatible&&url.endsWith('/like')?response(409,{code:'LEGACY_LIKES_UNRESOLVED'}):undefined});await page.ready();incompatible=true;await page.click();
  assert.match(page.feedback,/Historique non attribuable/);assert.equal(page.writes().length,0);assert.equal(page.button.disabled,true);
});
test('formulaires 6F.1 : écrire un like verrouille sans effacer les brouillons',async()=>{
  const gate=deferred();let hold=false;const page=mount('comment',{comments:true,fetch:async(url,req)=>{if(hold&&req.method==='POST'&&url.endsWith('/like'))await gate.promise;}});await page.ready();
  page.get('comment-text').value='Brouillon conservé';hold=true;const pending=page.click();await settle();
  assert.equal(page.get('comment-send').disabled,true);await page.get('comment-form').emit('submit');assert.equal(page.writes().length,1);
  gate.resolve();await pending;assert.equal(page.get('comment-text').value,'Brouillon conservé');assert.equal(page.get('comment-send').disabled,false);
});
test('sélection du signalement bloque les likes et Annuler conserve le commentaire',async()=>{
  const page=mount('comment',{comments:true});await page.ready();await page.get('comments-list').querySelectorAll('button')[0].emit('click');
  assert.equal(page.button.disabled,true);assert.equal(page.get('report-form').hidden,false);await page.click();assert.equal(page.writes().length,0);
  await page.get('report-cancel').emit('click');assert.equal(page.button.disabled,false);
});
test('pagehide empêche les nouvelles actions de likes de commentaires',async()=>{
  const page=mount('comment',{comments:true});await page.ready();await page.window.emit('pagehide');assert.equal(page.button.disabled,true);await page.click();assert.equal(page.writes().length,0);
});
