const $ = (id) => document.getElementById(id);

const EXPECTED_CART = [
  {
    "itemId": 597,
    "price": 1000,
    "qty": 5
  },
  {
    "itemId": 691,
    "price": 1500,
    "qty": 5
  },
  {
    "itemId": 180,
    "price": 1000,
    "qty": 1
  },
  {
    "itemId": 392,
    "price": 900,
    "qty": 1
  },
  {
    "itemId": 406,
    "price": 240,
    "qty": 1
  },
  {
    "itemId": 705,
    "price": 600,
    "qty": 1
  },
  {
    "itemId": 426,
    "price": 1200,
    "qty": 1
  },
  {
    "itemId": 494,
    "price": 900,
    "qty": 1
  },
  {
    "itemId": 340,
    "price": 600,
    "qty": 1
  },
  {
    "itemId": 695,
    "price": 900,
    "qty": 1
  }
];
const EXPECTED_CART_LINES = "597,1000,5\n691,1500,5\n180,1000,1\n392,900,1\n406,240,1\n705,600,1\n426,1200,1\n494,900,1\n340,600,1\n695,900,1";

const state = {
  objects: null,
  itemsById: new Map(),
  idByNameLower: new Map(),
  rows: [],
  workers: [],
  running: false,
  paused: false,
  stopRequested: false,
  total: 0,
  checked: 0,
  lastTick: performance.now(),
  lastChecked: 0,
  candidates: new Set(),
  inFlight: 0,
  workerBusy: [],
  sched: null,
};

function fmt(n){ return n.toLocaleString("en-US"); }
function toInt32(u){ return (u|0); }

// Even-seeds-only mode (Switch). We always use the seed>>>1 mapping in worker.
const USE_DIV2_ALWAYS = true;
function toEvenU32(n){
  return ((n >>> 0) & ~1) >>> 0;
}

// --- Traveling Cart date selector (daysPlayed) ---
// If #cartDate exists, we use it (and populate it). Otherwise fall back to numeric #daysPlayed.
const SEASONS = ["Spring","Summer","Fall","Winter"];
const DOW = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
const DAYS_PER_SEASON = 28;
const DAYS_PER_YEAR = 112;

function toDaysPlayed(year, seasonIndex, day){
  return (year-1)*DAYS_PER_YEAR + seasonIndex*DAYS_PER_SEASON + day;
}

function isNightMarket(seasonIndex, day){
  return (seasonIndex===3 && day>=15 && day<=17); // Winter 15-17
}

function isDesertFestival(seasonIndex, day){
  return (seasonIndex===0 && day>=15 && day<=17); // Spring 15-17
}

function isCartOpen(year, seasonIndex, day){
  // Exclude Desert Festival days in Year 1 (user requirement)
  if (year===1 && isDesertFestival(seasonIndex, day)) return false;

  // Special open windows
  if (isNightMarket(seasonIndex, day)) return true;
  if (isDesertFestival(seasonIndex, day)) return true;

  // Regular schedule: Fri + Sun
  const daysPlayed = toDaysPlayed(year, seasonIndex, day);
  const dow = (daysPlayed - 1) % 7; // Spring 1 Y1 assumed Monday
  return (dow === 4 || dow === 6);
}

function labelFor(year, seasonIndex, day){
  const daysPlayed = toDaysPlayed(year, seasonIndex, day);
  const dow = DOW[(daysPlayed - 1) % 7];
  let tag = "";
  if (isNightMarket(seasonIndex, day)) tag = " (Night Market)";
  else if (isDesertFestival(seasonIndex, day)) tag = " (Desert Festival)";
  return `Y${year} ${SEASONS[seasonIndex]} ${day} (${dow})${tag}`;
}

function populateCartDateSelect(){
  const sel = $("cartDate");
  if (!sel) return;
  const hint = $("daysPlayedHint");
  sel.innerHTML = "";

  // Practical default range; can be expanded later
  const MAX_YEAR = 3;

  const frag = document.createDocumentFragment();
  let defaultValue = null;

  for (let year=1; year<=MAX_YEAR; year++){
    for (let seasonIndex=0; seasonIndex<4; seasonIndex++){
      for (let day=1; day<=28; day++){
        if (!isCartOpen(year, seasonIndex, day)) continue;
        const dp = toDaysPlayed(year, seasonIndex, day);
        const opt = document.createElement("option");
        opt.value = String(dp);
        opt.textContent = labelFor(year, seasonIndex, day);
        frag.appendChild(opt);
        if (year===1 && seasonIndex===0 && day===5) defaultValue = String(dp);
      }
    }
  }

  sel.appendChild(frag);
  sel.value = defaultValue ?? sel.options[0]?.value ?? "5";

  const updateHint = ()=>{ if (hint) hint.textContent = `daysPlayed = ${sel.value}`; };
  sel.addEventListener("change", updateHint);
  updateHint();
}

function getDaysPlayed(){
  const sel = $("cartDate");
  if (sel){
    const v = Number(sel.value);
    return (Number.isFinite(v) && v > 0) ? v : 5;
  }
  const el = $("daysPlayed");
  const v = Number(el?.value);
  return (Number.isFinite(v) && v > 0) ? v : 5;
}

function setStatus(msg, isError=false){
  const el = $("status");
  el.textContent = msg;
  el.classList.toggle("danger", isError);
}
function setPasteMsg(msg, isError=false){
  const el = $("pasteMsg");
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? "#b91c1c" : "";
}
function setPreviewOut(text){ const el=$("previewOut"); if(el) el.textContent=text; }

function updatePills(){
  const pct = state.total ? (state.checked/state.total)*100 : 0;
  $("progressPill").textContent = `${pct.toFixed(2)}%`;
  $("checkedPill").textContent = `checked ${fmt(state.checked)}`;
  const now = performance.now();
  const dt = (now-state.lastTick)/1000;
  if (dt>=0.5){
    const delta = state.checked-state.lastChecked;
    $("ratePill").textContent = `${fmt(Math.round(delta/dt))} seeds/s`;
    state.lastTick=now; state.lastChecked=state.checked;
  }
  $("remainingPill").textContent = `candidates ${fmt(state.candidates.size)}`;
  $("objectsPill").textContent = `objects ${state.objects?fmt(Object.keys(state.objects).length):0}`;
}

function renderCandidates(){
  const tb=$("candidates"); tb.innerHTML="";
  const arr=[...state.candidates].sort((a,b)=>a-b).slice(0,50);
  for(const u of arr){
    const tr=document.createElement("tr");
    tr.innerHTML=`<td>${u}</td><td>${toInt32(u)}</td><td>${u>>>1}</td>`;
    tb.appendChild(tr);
  }
}

function clearRowErrors(){
  for (const r of state.rows){
    r.itemEl.classList.remove("err");
    r.priceEl.classList.remove("err");
    r.qtyEl.classList.remove("err");
  }
}

function normalizeItemInputToId(raw){
  const s=(raw??"").trim();
  if(!s) return null;
  if(/^\d+$/.test(s)) return Number(s);
  const m=s.match(/\((\d+)\)\s*$/);
  if(m) return Number(m[1]);
  const id=state.idByNameLower.get(s.toLowerCase());
  return (id!==undefined)?id:null;
}

function readCartFromGrid(){
  clearRowErrors();
  const cart=[]; let ok=true;
  for (const r of state.rows){
    const itemId=normalizeItemInputToId(r.itemEl.value);
    const price=Number(r.priceEl.value);
    const qty=Number(r.qtyEl.value);
    if(itemId===null||!state.itemsById.has(itemId)){ r.itemEl.classList.add("err"); ok=false; }
    if(!Number.isFinite(price)||price<=0){ r.priceEl.classList.add("err"); ok=false; }
    if(![1,5].includes(qty)){ r.qtyEl.classList.add("err"); ok=false; }
    cart.push({itemId,price,qty});
  }
  if(!ok) throw new Error("Fix highlighted cart input fields.");
  return cart;
}

function applyCartToGrid(cart){
  for(let i=0;i<4;i++) {
    const r=state.rows[i]; const row=cart[i];
    const o=state.itemsById.get(row.itemId);
    r.itemEl.value = o?.name ? `${o.name} (${row.itemId})` : String(row.itemId);
    r.priceEl.value = String(row.price);
    r.qtyEl.value = String(row.qty);
  }
}

function cartToLines(cart){ return cart.map(r=>`${r.itemId},${r.price},${r.qty}`).join("\n"); }

function parseQuickPaste(text){
  const lines=(text||"").split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  if(lines.length!==4 && lines.length!==10) throw new Error(`Quick paste expects 4 lines (or 10 from full cart), got ${lines.length}.`);
  const useLines = (lines.length===10) ? lines.slice(0,4) : lines;
  return useLines.map((line,idx)=>{
    const parts=line.split(",").map(s=>s.trim());
    if(parts.length!==3) throw new Error(`Line ${idx+1}: expected itemId,price,qty.`);
    const itemId=Number(parts[0]), price=Number(parts[1]), qty=Number(parts[2]);
    if(!Number.isFinite(itemId)) throw new Error(`Line ${idx+1}: invalid itemId.`);
    if(!Number.isFinite(price)||price<=0) throw new Error(`Line ${idx+1}: invalid price.`);
    if(![1,5].includes(qty)) throw new Error(`Line ${idx+1}: qty must be 1 or 5.`);
    return {itemId,price,qty};
  });
}


function initWorkers(n){
  state.workers.forEach(w=>w.terminate());
  state.workers=[];
  state.workerBusy = Array(n).fill(false);
  state.inFlight = 0;
  for(let i=0;i<n;i++) {
    const w=new Worker("./worker.js?v="+Date.now());
    w.onmessage=(e)=>onWorker(i, e.data);
    state.workers.push(w);
  }
}

function onWorker(i, msg){
  if(msg.type==="progress"){
    state.checked += msg.payload.checked;
    updatePills();
  }
  else if(msg.type==="candidate"){
    state.candidates.add(msg.payload.seed>>>0);
    renderCandidates();
    updatePills();
  }
  else if(msg.type==="previewCart"){
    const items=msg.payload.items;
    setPreviewOut(items.map((it,idx)=>`${idx+1}. ${it.name} (${it.id})  price=${it.price}  qty=${it.qty}`).join("\n"));
  }
  else if(msg.type==="chunkDone"){
    // One in-flight chunk per worker.
    if(state.workerBusy?.[i]) state.workerBusy[i]=false;
    if(state.inFlight>0) state.inFlight--;

    // If we are running, immediately pump more work.
    if(state.running && !state.paused && state.sched?.pump) {
      state.sched.pump();
    }
  }
}

function broadcast(type,payload){ state.workers.forEach(w=>w.postMessage({type,payload})); }

function schedule({start,end,chunk}){
  const sched = {
    cursor: start>>>0,
    end: end,
    chunk: chunk,
    pump: null,
  };

  const pump = ()=>{
    if(!state.running||state.paused) return;
    if(state.stopRequested){
      state.running=false;
      broadcast("stop",{});
      state.sched=null;
      setStatus("Stopped.");
      return;
    }

    // Dispatch work only to free workers (at most one in-flight chunk per worker).
    for(let i=0;i<state.workers.length;i++) {
      if(state.workerBusy[i]) continue;
      if(sched.cursor>=sched.end) break;
      const s=sched.cursor;
      const e=Math.min(sched.end, sched.cursor + sched.chunk);
      sched.cursor = e;
      const eU32 = (e >= 4294967296) ? 0 : (e >>> 0);
      state.workerBusy[i]=true;
      state.inFlight++;
      state.workers[i].postMessage({type: "runChunk", payload:{start: s>>>0, end: eU32}});
    }

    // Finish only after all scheduled work is done.
    if(sched.cursor>=sched.end && state.inFlight===0){
      state.running=false;
      state.sched=null;
      setStatus(`Finished. Found ${state.candidates.size}.`);
      enableButtons(false);
      return;
    }

    // Keep pumping to fill newly free workers; keep it cheap.
    setTimeout(pump, 0);
  };

  sched.pump=pump;
  state.sched=sched;
  pump();
}

async function loadObjects(){
  const r=await fetch("./objects.json");
  if(!r.ok) throw new Error("objects.json not found (place it next to index.html and use a local server).");
  return await r.json();
}

function buildLookups(){
  for(const key of Object.keys(state.objects)){
    const o=state.objects[key]; const id=Number(o.id);
    if(!Number.isFinite(id)) continue;
    state.itemsById.set(id,o);
    const name=(o.name??"").toString();
    if(name&&!state.idByNameLower.has(name.toLowerCase())) state.idByNameLower.set(name.toLowerCase(), id);
  }
}

// main.js — UI-only change: filter datalist suggestions to Traveling Cart–eligible items
// This does NOT affect seed search logic or worker behavior.

// --- Traveling Cart eligibility (UI-only helper) ---
// Mirrors worker.js cart filters, but is ONLY used for dropdown/typeahead.
function isCartEligibleObject(o){
  const parsedId = Number(o?.id);
  if (!Number.isFinite(parsedId)) return false;
  if (parsedId < 2 || parsedId > 789) return false;
  if (o.offlimits) return false;

  const basePrice = Number(o?.price);
  if (!Number.isFinite(basePrice) || basePrice === 0) return false;

  const cat = Number(o?.category);
  if (!Number.isFinite(cat)) return false;
  if (cat >= 0 || cat === -999) return false;

  const t = (o?.type ?? "").toString();
  if (t === "Arch" || t === "Minerals" || t === "Quest") return false;

  return true;
}

function populateDatalist(){
  const dl = $("itemsList");
  dl.innerHTML = "";

  const items = [];

  // UI-only: only suggest items that can actually appear in the Traveling Cart
  for (const [id, o] of state.itemsById.entries()){
    const name = (o?.name ?? "").toString();
    if (!name) continue;
    if (!isCartEligibleObject(o)) continue;
    items.push({ id, name });
  }

  items.sort((a, b) => a.name.localeCompare(b.name));

  const frag = document.createDocumentFragment();
  for (const it of items){
    const opt = document.createElement("option");
    opt.value = `${it.name} (${it.id})`;
    frag.appendChild(opt);
  }

  dl.appendChild(frag);
}


function renderGrid(){
  const tb=$("cartGrid"); tb.innerHTML=""; state.rows=[];
  const frag=document.createDocumentFragment();
  for(let i=0;i<4;i++) {
    const tr=document.createElement("tr");
    const slotTd=document.createElement("td"); slotTd.textContent=String(i+1);
    const itemTd=document.createElement("td"); const itemEl=document.createElement("input");
    itemEl.className="itemInput"; itemEl.setAttribute("list","itemsList"); itemEl.placeholder="Type item name or ID…";
    itemTd.appendChild(itemEl);
    const priceTd=document.createElement("td"); const priceEl=document.createElement("input");
    priceEl.className="priceInput"; priceEl.type="number"; priceEl.min="1"; priceEl.placeholder="Exact price";
    priceTd.appendChild(priceEl);
    const qtyTd=document.createElement("td"); const qtyEl=document.createElement("select"); qtyEl.className="qtySelect";
    const o0=document.createElement("option"); o0.value=""; o0.textContent="-";
    const o1=document.createElement("option"); o1.value="1"; o1.textContent="1";
    const o5=document.createElement("option"); o5.value="5"; o5.textContent="5";
    qtyEl.appendChild(o0); qtyEl.appendChild(o1); qtyEl.appendChild(o5);
    qtyEl.value="";
    qtyTd.appendChild(qtyEl);
    tr.appendChild(slotTd); tr.appendChild(itemTd); tr.appendChild(priceTd); tr.appendChild(qtyTd);
    frag.appendChild(tr);
    state.rows.push({slot:i+1,itemEl,priceEl,qtyEl});
  }
  tb.appendChild(frag);
  $("gridHint").textContent="Tip: choose from suggestions (Name (ID)) or type numeric ID directly.";
}

function enableButtons(running){ $("pauseBtn").disabled=!running; $("resumeBtn").disabled=true; $("stopBtn").disabled=!running; }

$("applyPasteBtn").onclick=()=>{ try{ applyCartToGrid(parseQuickPaste($("quickPaste").value)); setPasteMsg("Applied to grid."); }catch(e){ setPasteMsg(e.message||String(e),true); } };
$("copyGridBtn").onclick=async()=>{ try{ await navigator.clipboard.writeText(cartToLines(readCartFromGrid())); setPasteMsg("Copied."); }catch(e){ setPasteMsg(e.message||String(e),true); } };
$("loadHardcodedBtn")?.addEventListener("click", ()=>{
  try{ applyCartToGrid(EXPECTED_CART); $("quickPaste").value=EXPECTED_CART_LINES; setPasteMsg("Loaded hard-coded cart."); }
  catch(e){ setPasteMsg(e.message||String(e),true); }
});

$("previewBtn").onclick=()=>{
  try{
    if(!state.objects) throw new Error("Still loading objects.json…");
    const raw=$("previewSeed").value; if(raw==="") throw new Error("Enter a seed to preview.");
    const seed=Number(raw); if(!Number.isFinite(seed)||seed<0) throw new Error("Invalid seed.");
    const seedEven = toEvenU32(seed);
    if(!state.workers.length){
      initWorkers(1);
      state.workers[0].postMessage({type:"init",payload:{objects:state.objects,cart:EXPECTED_CART,dayAdjust:0,a_daysPlayed:getDaysPlayed(),useLegacyRandom:false,useDiv2:USE_DIV2_ALWAYS}});
    }
    state.workers[0].postMessage({type:"previewCart", payload:{seed: seedEven, a_daysPlayed: getDaysPlayed(), useDiv2: USE_DIV2_ALWAYS}});
    setPasteMsg("Preview requested.");
  }catch(e){ setPasteMsg(e.message||String(e),true); }
};

$("selfTestBtn").onclick=()=>{
  try{
    if(!state.objects) throw new Error("Still loading objects.json…");
    const seed = (Math.random()*0x100000000)>>>0;
    const seedEven = toEvenU32(seed);
    $("previewSeed").value=String(seedEven);
    $("start").value=String(seedEven);
    $("end").value=String((seedEven+2)>>>0);
    if(!state.workers.length){
      initWorkers(1);
      state.workers[0].postMessage({type:"init",payload:{objects:state.objects,cart:EXPECTED_CART,dayAdjust:0,a_daysPlayed:getDaysPlayed(),useLegacyRandom:false,useDiv2:USE_DIV2_ALWAYS}});
    }
    const handler=(e)=>{
      if(e.data?.type!=="previewCart") return;
      state.workers[0].removeEventListener("message", handler);
      const items=e.data.payload.items;
      const asCart=items.map(it=>({itemId:it.id, price:it.price, qty:it.qty}));
      applyCartToGrid(asCart);
      $("quickPaste").value=cartToLines(asCart);
      setPasteMsg("Self-test filled grid; press Start.");
    };
    state.workers[0].addEventListener("message", handler);
    state.workers[0].postMessage({type:"previewCart", payload:{seed: seedEven, a_daysPlayed: getDaysPlayed(), useDiv2: USE_DIV2_ALWAYS}});
  }catch(e){ setPasteMsg(e.message||String(e),true); }
};

$("startBtn").onclick=()=>{
  try{
    const cart=readCartFromGrid();
    const workers=Number($("workers").value)||4;
    const startRaw=Number($("start").value)||0;
    const endRaw=Number($("end").value)||4294967296;
    const start=toEvenU32(startRaw);
    const end=(endRaw>=4294967296)?4294967296:toEvenU32(endRaw);
    const chunk=Number($("chunk").value)||2000000;
    const daysPlayed=getDaysPlayed();
    const useDiv2=USE_DIV2_ALWAYS;

    state.running=true; state.paused=false; state.stopRequested=false;
    state.inFlight=0;
    state.total=(end-start)/2; state.checked=0; state.candidates.clear();
    initWorkers(workers);
    for(const w of state.workers){ w.postMessage({type:"init",payload:{objects:state.objects,cart,dayAdjust:0,a_daysPlayed:daysPlayed,useLegacyRandom:false,useDiv2}}); }
    setStatus("Running…"); updatePills(); renderCandidates(); enableButtons(true);
    schedule({start,end,chunk});
  }catch(e){ setStatus(e.message||String(e),true); }
};

$("pauseBtn").onclick=()=>{ state.paused=true; $("pauseBtn").disabled=true; $("resumeBtn").disabled=false; setStatus("Paused."); };
$("resumeBtn").onclick=()=>{ state.paused=false; $("pauseBtn").disabled=false; $("resumeBtn").disabled=true; setStatus("Running…"); };
$("stopBtn").onclick=()=>{ state.stopRequested=true; $("pauseBtn").disabled=true; $("resumeBtn").disabled=true; $("stopBtn").disabled=true; };

(async()=>{
  try{
    setStatus("Loading objects.json…");
    state.objects=await loadObjects();
    buildLookups(); populateDatalist(); renderGrid();
    populateCartDateSelect();
    setStatus(`Loaded ${Object.keys(state.objects).length} objects. Ready.`);
    updatePills();
  }catch(e){ setStatus(e.message||String(e),true); }
})();
