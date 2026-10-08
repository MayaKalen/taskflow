// TaskFlow cloud sync: Google sign-in, Firestore storage and view-only sharing.
// Loaded after the main script; does nothing unless firebase-config.js sets window.FIREBASE_CONFIG.
import {initializeApp} from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js';
import {getAuth,onAuthStateChanged,GoogleAuthProvider,signInWithPopup,signInWithRedirect,signOut} from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js';
import {initializeFirestore,persistentLocalCache,persistentMultipleTabManager,doc,getDoc,setDoc,updateDoc,deleteDoc,collection,onSnapshot,writeBatch,arrayUnion,arrayRemove,serverTimestamp} from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js';

const cfg=window.FIREBASE_CONFIG;
if(cfg)start();

function start(){
  const app=initializeApp(cfg);
  const auth=getAuth(app);
  const fs=initializeFirestore(app,{localCache:persistentLocalCache({tabManager:persistentMultipleTabManager()})});
  const base=location.origin+location.pathname;
  const SHARED_KEY='taskflow.shared';

  let boardRef=null,unsubs=[],synced=new Map(),remarks=new Map(),flushTimer=null,firstTasks=true;

  const Cloud=window.Cloud={user:null,boardUid:null,ownerName:'',viewers:[],queue,addRemark,delRemark,deleteTaskRemarks,importTasks,acctHTML,actions:{}};

  /* ---------- gate screens ---------- */
  const gate=$('#gate');
  function showGate(title,msg,buttons=''){
    gate.hidden=false;
    gate.innerHTML=`<div class="gate-box"><div class="logo"></div><h1>${title}</h1><p>${msg}</p>${buttons}</div>`;
  }
  const googleBtn=`<button class="btn primary" data-act="signIn">Sign in with Google</button>`;
  function showSignIn(){
    const shared=new URLSearchParams(location.search).get('board');
    showGate('TaskFlow',shared?'Sign in to view the tasks that were shared with you.':'Sign in to see your tasks on any device.',
      googleBtn+(shared?'<small>Use the Google account whose email the tasks were shared with.</small>':''));
  }
  function showDenied(){
    showGate('No access to this board',`You're signed in as <b>${esc(Cloud.user?.email||'')}</b>, which hasn't been given access. Ask the owner to add this email under <b>Share</b>.`,
      `<button class="btn primary" data-act="switchAccount">Use a different Google account</button><small><a href="${base}">Go to my own tasks</a></small>`);
  }
  function showError(e){
    console.error(e);
    showGate('Something went wrong',esc(e?.message||String(e)),`<button class="btn primary" onclick="location.reload()">Try again</button>`);
  }
  showGate('TaskFlow','Loading…');

  /* ---------- auth ---------- */
  Cloud.actions.signIn=async()=>{
    const provider=new GoogleAuthProvider();
    provider.setCustomParameters({prompt:'select_account'});
    try{await signInWithPopup(auth,provider)}
    catch(e){
      if(e.code==='auth/popup-blocked'||e.code==='auth/operation-not-supported-in-this-environment')return signInWithRedirect(auth,provider);
      if(e.code==='auth/popup-closed-by-user'||e.code==='auth/cancelled-popup-request')return;
      if(e.code==='auth/unauthorized-domain')return showGate('Website not authorized yet',`Add <b>${esc(location.hostname)}</b> under Firebase → Authentication → Settings → Authorized domains, then try again.`,googleBtn);
      toast('Sign-in failed: '+(e.code||e.message));
    }
  };
  Cloud.actions.signOut=async()=>{
    if(flushTimer){clearTimeout(flushTimer);await flush()}
    await signOut(auth);
  };
  Cloud.actions.switchAccount=async()=>{await signOut(auth);Cloud.actions.signIn()};

  onAuthStateChanged(auth,user=>{
    unsubs.forEach(u=>u());unsubs=[];
    synced=new Map();remarks=new Map();firstTasks=true;boardRef=null;
    db.tasks=[];ui.openId=null;$('#overlay').hidden=true;closeShare();
    Cloud.user=user;
    if(!user){ui.ro=false;render();showSignIn();return}
    openBoard(user).catch(showError);
  });

  async function openBoard(user){
    const params=new URLSearchParams(location.search);
    let uid=params.get('board')||user.uid;
    if(uid===user.uid&&params.has('board'))history.replaceState(null,'',base);
    Cloud.boardUid=uid;ui.ro=uid!==user.uid;
    boardRef=doc(fs,'boards',uid);
    showGate('TaskFlow','Loading your tasks…');

    try{
      const snap=await getDoc(boardRef);
      if(!snap.exists()){
        if(ui.ro)return showDenied();
        await setDoc(boardRef,{ownerUid:user.uid,ownerEmail:(user.email||'').toLowerCase(),ownerName:user.displayName||user.email||'',viewers:[],createdAt:serverTimestamp()});
      }
    }catch(e){
      if(e.code==='permission-denied')return showDenied();
      if(e.code!=='unavailable')throw e; // offline: carry on with the local cache
    }

    const onErr=e=>{if(e.code==='permission-denied')showDenied();else showError(e)};
    unsubs.push(onSnapshot(boardRef,s=>{
      const d=s.data()||{};
      Cloud.ownerName=d.ownerName||d.ownerEmail||'';Cloud.viewers=d.viewers||[];
      if(ui.ro&&s.exists())rememberShared(uid,Cloud.ownerName);
      if(!$('#shareOverlay').hidden)renderShare();
      renderSoft();
    },onErr));
    unsubs.push(onSnapshot(collection(boardRef,'tasks'),applyTasks,onErr));
    unsubs.push(onSnapshot(collection(boardRef,'remarks'),applyRemarks,onErr));
  }

  /* ---------- reading ---------- */
  // Stable JSON so key order never makes an unchanged task look modified.
  function stable(v){
    if(Array.isArray(v))return '['+v.map(stable).join(',')+']';
    if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}';
    return JSON.stringify(v??null);
  }
  function toDoc(t){const{comments,...rest}=t;return JSON.parse(JSON.stringify(rest))}
  function fromDoc(id,d){
    return Object.assign({desc:'',status:'todo',priority:'med',date:today(),due:'',subtasks:[],activity:[],entries:[],running:null,order:0,createdAt:Date.now()},d,{id,comments:remarks.get(id)||[]});
  }

  function applyTasks(snap){
    let changed=false;
    snap.docChanges().forEach(ch=>{
      const id=ch.doc.id;
      if(ch.type==='removed'){db.tasks=db.tasks.filter(t=>t.id!==id);synced.delete(id);changed=true;return}
      if(ch.doc.metadata.hasPendingWrites&&byId(id))return; // echo of our own write
      const data=ch.doc.data();synced.set(id,stable(data));
      const t=fromDoc(id,data),i=db.tasks.findIndex(x=>x.id===id);
      if(i>=0)db.tasks[i]=t;else db.tasks.push(t);
      changed=true;
    });
    if(firstTasks){firstTasks=false;gate.hidden=true;render();offerLocalUpload();return}
    if(changed)renderSoft();
  }
  function applyRemarks(snap){
    remarks=new Map();
    snap.docs.forEach(d=>{const r={id:d.id,...d.data()};if(!remarks.has(r.taskId))remarks.set(r.taskId,[]);remarks.get(r.taskId).push(r)});
    remarks.forEach(list=>list.sort((a,b)=>a.at-b.at));
    db.tasks.forEach(t=>t.comments=remarks.get(t.id)||[]);
    renderSoft();
  }
  // Re-render without stealing focus from whatever the user is typing in.
  function renderSoft(){
    if(firstTasks)return;
    const a=document.activeElement,typing=a&&/INPUT|TEXTAREA|SELECT/.test(a.tagName);
    renderTop();renderWeek();
    if(!(typing&&a.id==='search'))renderToolbar();
    if(!ui.quick)renderView();
    renderRunbar();
    if(ui.openId){
      if(!byId(ui.openId)){ui.openId=null;$('#overlay').hidden=true}
      else if(typing&&$('#drawer').contains(a))renderSide();
      else renderModal();
    }
  }

  /* ---------- writing ---------- */
  const setSync=txt=>{const el=$('#syncStatus');if(el)el.textContent=txt};
  function queue(){
    if(ui.ro||!boardRef)return;
    clearTimeout(flushTimer);flushTimer=setTimeout(flush,600);
    setSync('Saving…');
  }
  async function flush(){
    flushTimer=null;
    if(ui.ro||!boardRef)return;
    const ops=[],seen=new Set();
    for(const t of db.tasks){
      seen.add(t.id);
      const d=toDoc(t),s=stable(d);
      if(synced.get(t.id)!==s){ops.push([t.id,d]);synced.set(t.id,s)}
    }
    for(const id of [...synced.keys()])if(!seen.has(id)){ops.push([id,null]);synced.delete(id)}
    if(!ops.length){setSync('Saved');return}
    if(!navigator.onLine)setSync('Offline — will sync');
    try{
      for(let i=0;i<ops.length;i+=400){
        const b=writeBatch(fs);
        ops.slice(i,i+400).forEach(([id,d])=>{const r=doc(boardRef,'tasks',id);d?b.set(r,d):b.delete(r)});
        await b.commit();
      }
      setSync('Saved');
    }catch(e){console.error(e);setSync('Not saved');toast('Could not save: '+(e.code||e.message))}
  }
  const flushNow=()=>{if(flushTimer){clearTimeout(flushTimer);flush()}};
  addEventListener('pagehide',flushNow);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)flushNow()});

  const remarkDoc=(taskId,text,at)=>({taskId,text,at,authorUid:Cloud.user.uid,authorEmail:(Cloud.user.email||'').toLowerCase(),authorName:Cloud.user.displayName||Cloud.user.email||''});
  function addRemark(taskId,text){
    const r=doc(collection(boardRef,'remarks'));
    return setDoc(r,remarkDoc(taskId,text,Date.now()));
  }
  function delRemark(id){return deleteDoc(doc(boardRef,'remarks',id))}
  function deleteTaskRemarks(taskId){
    const list=remarks.get(taskId)||[];if(!list.length)return;
    const b=writeBatch(fs);list.forEach(r=>b.delete(doc(boardRef,'remarks',r.id)));
    return b.commit().catch(e=>console.error(e));
  }
  // Replace every task (and remark) on the board, e.g. from a backup file or this browser's old local data.
  async function importTasks(tasks){
    const clean=tasks.map(t=>Object.assign({subtasks:[],comments:[],activity:[],entries:[],desc:'',due:'',priority:'med',status:'todo',running:null,order:0,createdAt:Date.now(),date:today()},t));
    const ops=[];
    remarks.forEach(list=>list.forEach(r=>ops.push(b=>b.delete(doc(boardRef,'remarks',r.id)))));
    clean.forEach(t=>t.comments.forEach(c=>ops.push(b=>b.set(doc(collection(boardRef,'remarks')),remarkDoc(t.id,String(c.text||''),c.at||Date.now())))));
    for(let i=0;i<ops.length;i+=400){const b=writeBatch(fs);ops.slice(i,i+400).forEach(f=>f(b));await b.commit()}
    db.tasks=clean.map(t=>Object.assign(t,{comments:[]}));
    render();
    await flush();
  }
  function offerLocalUpload(){
    if(ui.ro)return;
    const flag='taskflow.uploaded.'+Cloud.user.uid;
    let local;try{if(localStorage.getItem(flag))return;local=JSON.parse(localStorage.getItem(KEY))}catch(e){return}
    const n=local?.tasks?.length||0;
    if(!n)return;
    try{localStorage.setItem(flag,'1')}catch(e){}
    if(db.tasks.length)return; // account already has tasks; use Import for anything else
    if(confirm(`This browser has ${n} task(s) saved from before you signed in.\n\nUpload them to your account so they're available everywhere?`))
      importTasks(local.tasks).then(()=>toast(`Uploaded ${n} task(s)`),e=>{console.error(e);toast('Upload failed — use Export / Import instead')});
  }

  /* ---------- account menu ---------- */
  function sharedList(){try{return JSON.parse(localStorage.getItem(SHARED_KEY))||[]}catch(e){return[]}}
  function rememberShared(uid,name){
    const list=sharedList().filter(x=>x.uid!==uid);list.unshift({uid,name});
    try{localStorage.setItem(SHARED_KEY,JSON.stringify(list.slice(0,10)))}catch(e){}
  }
  function acctHTML(){
    const u=Cloud.user;if(!u)return '';
    const name=u.displayName||u.email||'';
    const av=u.photoURL?`<img src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer">`:esc(name.slice(0,1).toUpperCase());
    const boards=sharedList().filter(b=>b.uid!==u.uid);
    return `<span class="sync" id="syncStatus">${ui.ro?'':'Saved'}</span>
      ${ui.ro?'':`<button class="btn" data-act="share">Share</button>`}
      <details class="acct"><summary><span class="avatar">${av}</span>${esc(name.split(' ')[0])}</summary>
      <div class="menu">
        <div class="lbl">Signed in as</div><div style="padding:0 10px 6px;font-size:12px;color:var(--muted);word-break:break-all">${esc(u.email||'')}</div><hr>
        <div class="lbl">Boards</div>
        <a href="${base}" class="${ui.ro?'':'on'}">My tasks</a>
        ${boards.map(b=>`<a href="${base}?board=${encodeURIComponent(b.uid)}" class="${b.uid===Cloud.boardUid?'on':''}">${esc(b.name||'Shared board')}'s tasks</a>`).join('')}
        <hr>
        ${ui.ro?'':`<button data-act="share">Share with manager</button>`}
        <button data-act="signOut">Sign out</button>
      </div></details>`;
  }
  document.addEventListener('click',e=>{if(!e.target.closest('.acct'))document.querySelectorAll('details.acct[open]').forEach(d=>d.open=false)});

  /* ---------- sharing ---------- */
  const shareLink=()=>`${base}?board=${Cloud.boardUid}`;
  function renderShare(){
    $('#share').innerHTML=`<h2>Share with your manager</h2>
      <p>People you add can see all your tasks, times and history and add remarks, but they can't change anything.</p>
      <div class="row"><input id="viewerEmail" type="email" placeholder="manager@company.com" autocomplete="off"><button class="btn primary" data-act="addViewer">Add</button></div>
      ${Cloud.viewers.length?Cloud.viewers.map(v=>`<div class="viewer"><span class="avatar" style="width:22px;height:22px">${esc(v[0].toUpperCase())}</span><span>${esc(v)}</span><button class="x" data-act="removeViewer" data-email="${esc(v)}" title="Remove access">${I.xs}</button></div>`).join(''):'<div class="empty" style="text-align:left;padding:4px 0 10px">Nobody has access yet.</div>'}
      <p style="margin:14px 0 6px">Then send them this link. They sign in with the Google account for the email you added:</p>
      <div class="row"><input readonly value="${esc(shareLink())}" id="shareLink"><button class="btn" data-act="copyLink">Copy</button></div>
      <div class="foot"><button class="btn" data-act="closeShare">Done</button></div>`;
  }
  function closeShare(){$('#shareOverlay').hidden=true}
  Cloud.actions.share=()=>{$('#shareOverlay').hidden=false;renderShare();$('#viewerEmail').focus()};
  Cloud.actions.closeShare=closeShare;
  Cloud.actions.addViewer=async()=>{
    const el=$('#viewerEmail'),email=el.value.trim().toLowerCase();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){toast('Enter a valid email address');return}
    if(email===(Cloud.user.email||'').toLowerCase()){toast("That's your own email");return}
    try{await updateDoc(boardRef,{viewers:arrayUnion(email)});toast('Access given to '+email)}
    catch(e){toast('Could not share: '+(e.code||e.message))}
  };
  Cloud.actions.removeViewer=async a=>{
    const email=a.dataset.email;if(!confirm(`Remove ${email}'s access?`))return;
    try{await updateDoc(boardRef,{viewers:arrayRemove(email)})}catch(e){toast('Could not remove: '+(e.code||e.message))}
  };
  Cloud.actions.copyLink=()=>{
    const el=$('#shareLink');
    (navigator.clipboard?.writeText(el.value)||Promise.reject()).then(()=>toast('Link copied'),()=>{el.select();document.execCommand('copy');toast('Link copied')});
  };
  $('#shareOverlay').addEventListener('mousedown',e=>{if(e.target.id==='shareOverlay')closeShare()});
  document.addEventListener('keydown',e=>{
    if(e.target.id==='viewerEmail'&&e.key==='Enter'){e.preventDefault();Cloud.actions.addViewer()}
    else if(e.key==='Escape'&&!$('#shareOverlay').hidden)closeShare();
  });
}
