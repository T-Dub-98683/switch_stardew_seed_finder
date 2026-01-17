importScripts("./vendor/cs-random.js");
importScripts("./vendor/xxhash.min.js");

function getHashFromArray(values){
  const a=new Int32Array(values);
  const h=XXH.h32();
  return h.update(a.buffer).digest().toNumber();
}

function getRandomSeed(a,b=0,c=0,d=0,e=0,useLegacyRandom=false){
  const mod=2147483647;
  const aa=(a%mod)|0, bb=(b%mod)|0, cc=(c%mod)|0, dd=(d%mod)|0, ee=(e%mod)|0;
  if(useLegacyRandom){ let s=(aa+bb+cc+dd+ee)%mod; if(s<0)s+=mod; return s; }
  return getHashFromArray([aa,bb,cc,dd,ee]);
}

let cart=null;
let constants=null;
let allKeys=null;
let allObj=null;

let expId=null;
let expPrice=null;
let expQty=null;

function buildEligible(objects){
  allKeys=[]; allObj={};
  for (const k in objects){ allKeys.push(k); allObj[k]=objects[k]; }
}


function getRandomItemsCart(rng){
  const shuffledItems={};
  for (let i=0;i<allKeys.length;i++){
    const idKey=allKeys[i];
    const key=rng.Next(); // burn for every entry
    const o=allObj[idKey];
    const parsedId=Number(o?.id);
    if (Number.isNaN(parsedId)) continue;
    if (o.price == 0) continue;
    if (o.offlimits) continue;
    if (parsedId >= 2 && parsedId <= 789){
      shuffledItems[key]=idKey;
    }
  }
  const selected=[];
  let slot=1;
  for (const key in shuffledItems){
    const idKey=shuffledItems[key];
    const o=allObj[idKey];
    if (o.category >= 0 || o.category === -999) continue;
    if (o.type === "Arch" || o.type === "Minerals" || o.type === "Quest") continue;
    selected.push(idKey);
    if (slot++ >= 10) break;
  }
  return selected;
}


function generateCart(seedU32, a_daysPlayedOverride, useDiv2Override){
  const seed = seedU32 >>> 0;
  const a_daysPlayed = (a_daysPlayedOverride !== undefined) ? (a_daysPlayedOverride|0) : (constants.a_daysPlayed|0);
  const useDiv2 = (useDiv2Override !== undefined) ? !!useDiv2Override : !!constants.useDiv2;

  const a = (a_daysPlayed + (constants.dayAdjust|0)) | 0;
  const b = useDiv2 ? (seed>>>1) : (seed|0);

  const rng=new CSRandom(getRandomSeed(a,b,0,0,0,constants.useLegacyRandom));
  const picks=getRandomItemsCart(rng);

  const items=[];
  for (let i=0;i<10;i++){
    const idKey=picks[i];
    const obj=allObj[idKey];
    const itemId=Number(obj.id);
    const basePrice=Number(obj.price);
    const price=Math.max(rng.Next(1,11)*100, rng.Next(3,6)*basePrice);
    const qty=(rng.NextDouble()<0.1)?5:1;
    items.push({id:itemId, name: obj.name ?? String(itemId), price, qty});
  }
  return items;
}

function matchNoAlloc(seedU32){
  const seed = seedU32 >>> 0;
  const a_daysPlayed = (constants.a_daysPlayed|0);
  const useDiv2 = !!constants.useDiv2;


  const a = (a_daysPlayed + (constants.dayAdjust|0)) | 0;
  const b = useDiv2 ? (seed>>>1) : (seed|0);

  const rng = new CSRandom(getRandomSeed(a,b,0,0,0,constants.useLegacyRandom));
  const picks = getRandomItemsCart(rng);

  const n = expId ? expId.length : 0;
  for (let i=0;i<n;i++){
    const idKey = picks[i];
    const obj = allObj[idKey];
    const itemId = Number(obj.id);
    if (itemId !== expId[i]) return false;
    const basePrice = Number(obj.price);
    const price = Math.max(rng.Next(1,11)*100, rng.Next(3,6)*basePrice);
    if (price !== expPrice[i]) return false;
    const qty = (rng.NextDouble()<0.1)?5:1;
    if (qty !== expQty[i]) return false;
  }
  return true;
}

function match(seedU32){
  return matchNoAlloc(seedU32);
}


let stop=false;

self.onmessage=(e)=>{
  const {type,payload}=e.data;

  if (type==="init"){
    cart=payload.cart;
    constants=payload;
    stop=false;
    const n = Array.isArray(cart) ? cart.length : 0;
    expId=new Int32Array(n);
    expPrice=new Int32Array(n);
    expQty=new Int8Array(n);
    for (let i=0;i<n;i++){
      expId[i]=cart[i].itemId|0;
      expPrice[i]=cart[i].price|0;
      expQty[i]=cart[i].qty|0;
    }
    buildEligible(payload.objects);
    return;
  }
  if (type==="stop"){ stop=true; return; }

  if (type==="previewCart"){
    const seed=payload.seed>>>0;
    const items=generateCart(seed, payload.a_daysPlayed, payload.useDiv2);
    self.postMessage({type:"previewCart", payload:{seed, items}});
    return;
  }

  if (type==="runChunk"){
    const start = payload.start >>> 0;
    const endU32 = payload.end >>> 0; // 0 means 2^32

    // Even-only scanning: Traveling Cart uses seed/2 (or equivalent), so odd/even gameIds are redundant.
    let s = (start & ~1) >>> 0; // round down to even representative
    let c = 0;
    let checkedTotal = 0;

    try {
      while (true){
        if (stop) break;

        if (match(s)) self.postMessage({type:"candidate", payload:{seed:s}});

        c++; checkedTotal++;
        if ((c & 0x3FFFF)===0){
          self.postMessage({type:"progress", payload:{checked:0x3FFFF}});
          c = 0;
        }

        const next = (s + 2) >>> 0;

        if (endU32 === 0){
          if (next === 0) break;         // reached 2^32
        } else {
          // stop when next would land on end (exclusive), or when we step past it
          if (next === endU32) break;
          if (next > endU32 && s < endU32) break;
        }

        s = next;
      }

      if (c) self.postMessage({type:"progress", payload:{checked:c}});
    } finally {
      self.postMessage({type:"chunkDone", payload:{checked: checkedTotal}});
    }
    return;
  }
};
