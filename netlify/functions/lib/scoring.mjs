// Scoring logic extracted from /public/index.html for server-side use.
// Keeps in sync with the client-side versions — if you change scoring
// rules in index.html, mirror them here.

// ── Store registry ────────────────────────────────────────────────────
export const STORES = [
  {id:'hammond',       name:'Hammond',          st:'LA'},
  {id:'grand_bay',     name:'Grand Bay',        st:'AL'},
  {id:'heflin',        name:'Heflin',           st:'AL'},
  {id:'calera',        name:'Calera',           st:'AL'},
  {id:'huntsville',    name:'Huntsville',       st:'AL'},
  {id:'hattiesburg',   name:'Hattiesburg',      st:'MS'},
  {id:'tupelo',        name:'Tupelo',           st:'MS'},
  {id:'breaux_bridge', name:'Breaux Bridge',    st:'LA'},
  {id:'defuniak',      name:'Defuniak Springs', st:'FL'},
  {id:'airstream',     name:'Airstream',        st:'BRAND', isAirstream:true},
];

export const VALID_STORE_IDS = new Set(STORES.map(s => s.id));

// ── Airstream identification rules ───────────────────────────────────
const AIRSTREAM_RULES = {
  LEAD_SOURCE_CONTAINS:       ['airstream','aimbase'],
  LEAD_SOURCE_GROUP_CONTAINS: ['airstream'],
  MAKE_CONTAINS:              ['airstream'],
  BAD_LEAD_STATUS_CUSTOM:     ['bad'],
  BAD_LEAD_STATUS_TYPE:       ['bad'],
};

function isAirstreamLead(row, H){
  const src  = (row[H.LEAD_SOURCE]    || '').trim().toLowerCase();
  const grp  = (row[H.LEAD_SRC_GROUP] || '').trim().toLowerCase();
  const make = (row[H.MAKE]           || '').trim().toLowerCase();
  if (src)  for (const v of AIRSTREAM_RULES.LEAD_SOURCE_CONTAINS)       if (src.includes(v))  return true;
  if (grp)  for (const v of AIRSTREAM_RULES.LEAD_SOURCE_GROUP_CONTAINS) if (grp.includes(v))  return true;
  if (make) for (const v of AIRSTREAM_RULES.MAKE_CONTAINS)              if (make.includes(v)) return true;
  return false;
}

function isAirstreamBadStatus(row, H){
  const custom = (row[H.LEAD_STATUS_CUSTOM] || '').trim().toLowerCase();
  const type   = (row[H.LEAD_STATUS_TYPE]   || '').trim().toLowerCase();
  if (custom) for (const v of AIRSTREAM_RULES.BAD_LEAD_STATUS_CUSTOM) if (custom === v) return true;
  if (type)   for (const v of AIRSTREAM_RULES.BAD_LEAD_STATUS_TYPE)   if (type === v)   return true;
  return false;
}

// ── Rep / manager rules ───────────────────────────────────────────────
const normName = n => String(n||'').trim().replace(/\s+/g,' ').toLowerCase();

const BLACKLIST = new Set([
  'Tony Vitrano','Christian Borrouso','Shane Roberts','Pete Smith',
  'Tyler Zimmerman','Ed Savage','Joe Steffen','Joshua Brevick',
  'James Duos','Justin Mire','James Murphy','Tommy Sacran',
  'Jerry Jones','Chris Seehorn','Matthew Kramer','Mike Lindemood',
  'Michael Lindemood',
  'Steve Smith','Bradley Smart','Matthew Justice','John Schuster',
].map(normName));

const SYS_PATTERNS = ['your friends at great american rv','yod house agent'];
const MGR_GROUPS   = new Set(['Manager','Reception','Admin']);
const BAD_STATUSES = new Set([
  'Bad Credit','Bad or no contact information','Dealer test lead',
  'Duplicate lead','No intent to buy','Out of market',
  'Purchased different brand different dealer','Purchased from private party',
  'Requested no further contact',
]);

const isSysAccount  = name => { const n = normName(name); return SYS_PATTERNS.some(p => n.includes(p)); };
const isTrackedRep  = (_storeId, name) => {
  const n = normName(name);
  if (!n) return false;
  if (BLACKLIST.has(n)) return false;
  if (isSysAccount(n)) return false;
  return true;
};

// ── Dealer name cleanup ───────────────────────────────────────────────
function cleanDealerName(s){
  if (!s) return '';
  return s.trim().replace(/^Great American RV SuperStores\s*[,]?\s*(of\s+)?/i, '').trim();
}

// ── Delivery signal ───────────────────────────────────────────────────
function isDelivered(r, H){
  return (r[H.LEAD_STATUS_TYPE]||'').trim() === 'Sold';
}

// ── Customer dedup (union-find) ───────────────────────────────────────
function normPhone(p){
  const d = String(p||'').replace(/\D/g,'');
  const s = d.length===11 && d.startsWith('1') ? d.slice(1) : d;
  return s.length===10 ? s : '';
}
function normEmail(e){ const s = String(e||'').trim().toLowerCase(); return s.includes('@') ? s : ''; }
function normCust(c) { return String(c||'').trim().toLowerCase().replace(/\s+/g,' '); }

// One lead per customer (matched by name/email/phone), regardless of
// VIN/Stock Number — matches "no sale → collapse to one record" and
// "identical sold unit → one sale" by construction, since the winner
// is a single row chosen per customer group (prefer Sold, then latest
// Lead Origination Date).
//
// A customer with MORE than one Sold row for a genuinely different
// unit (distinct VIN-or-Stock-Number) is credited an extra delivery
// via `extraSales` — but that extra row is never added to the lead
// list, so it can never inflate valid_leads/total_leads. Net result
// for "customer buys 2 different units same day": 1 lead, 2 solds.
export function dedupCustomers(rows, H){
  const n = rows.length;
  const parent = new Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = x => { while(parent[x]!==x){ parent[x]=parent[parent[x]]; x=parent[x]; } return x; };
  const union = (a,b) => { const ra=find(a), rb=find(b); if(ra!==rb) parent[ra]=rb; };

  const byName={}, byEmail={}, byPhone={};
  for (let i = 0; i < n; i++){
    const r  = rows[i];
    const nm = normCust(r[H.CUSTOMER]);
    const em = normEmail(r[H.EMAIL]);
    const phones = [r[H.DAY_PHONE],r[H.EVE_PHONE],r[H.CELL_PHONE]].map(normPhone).filter(Boolean);
    if (nm){ if(byName[nm]!==undefined)  union(i,byName[nm]);  else byName[nm]=i; }
    if (em){ if(byEmail[em]!==undefined) union(i,byEmail[em]); else byEmail[em]=i; }
    for (const ph of phones){ if(byPhone[ph]!==undefined) union(i,byPhone[ph]); else byPhone[ph]=i; }
  }

  const groups = {};
  for (let i = 0; i < n; i++){ const k=find(i); (groups[k]=groups[k]||[]).push(i); }

  const unitKeyOf = i => {
    const vin   = (rows[i][H.VIN]       || '').trim().toUpperCase();
    const stock = (rows[i][H.STOCK_NUM] || '').trim().toUpperCase();
    return vin || stock || '';
  };

  const winners = [], extraSales = [];
  for (const k in groups){
    const idxs = groups[k];
    let best=idxs[0], bestSold=isDelivered(rows[best],H), bestTs=Date.parse(rows[best][H.LEAD_ORIG]||'')||0;
    for (let j=1; j<idxs.length; j++){
      const i=idxs[j], sold=isDelivered(rows[i],H), ts=Date.parse(rows[i][H.LEAD_ORIG]||'')||0;
      if ((sold&&!bestSold)||(sold===bestSold&&ts>bestTs)){ best=i; bestSold=sold; bestTs=ts; }
    }
    winners.push(rows[best]);

    if (idxs.length>1){
      const bestUnit = isDelivered(rows[best],H) ? unitKeyOf(best) : '';
      const seen = new Set(bestUnit ? [bestUnit] : []);
      for (const i of idxs){
        if (i===best) continue;
        if (!isDelivered(rows[i],H)) continue;
        const unit = unitKeyOf(i);
        if (!unit || seen.has(unit)) continue; // blank or already-credited unit: not a distinct sale
        seen.add(unit);
        extraSales.push(rows[i]);
      }
    }
  }
  return { leads: winners, extraSales };
}

// ── Formatting helpers ────────────────────────────────────────────────
const pct   = v => (v*100).toFixed(1)+'%';
const today = () => new Date().toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});

// ── CSV parser ────────────────────────────────────────────────────────
export function parseMasterCSVv2(txt){
  const rows=[];
  let row=[],field='',inQ=false;
  for (let i=0; i<txt.length; i++){
    const ch=txt[i];
    if (inQ){
      if (ch==='"'){
        if (txt[i+1]==='"'){ field+='"'; i++; }
        else { inQ=false; }
      } else { field+=ch; }
    } else {
      if (ch==='"'){ inQ=true; }
      else if (ch===','){ row.push(field); field=''; }
      else if (ch==='\n'){ row.push(field); rows.push(row); row=[]; field=''; }
      else if (ch==='\r'){/* skip */}
      else { field+=ch; }
    }
  }
  if (field.length||row.length){ row.push(field); rows.push(row); }
  if (rows.length<2) return null;

  rows[0][0] = rows[0][0].replace(/^﻿/,'');
  const header = rows[0];

  const H = {};
  for (let i=0; i<header.length; i++){
    const name = header[i].trim();
    if (!(name in H)) H[name]=i;
    else H[name+'_2']=i;
  }
  H.allHeaders = header.map(h => h.trim());

  H.LEAD_SOURCE     = H['Lead Source'];
  H.LEAD_TYPE       = H['Lead Type'];
  H.LEAD_SRC_GROUP  = H['Lead Source Group'];
  H.LEAD_STATUS     = H['Lead Status'];
  H.LEAD_STATUS_CUSTOM = H['Lead Status Custom'];
  H.LEAD_STATUS_TYPE   = H['Lead Status Type'];
  H.ADJ_RT          = H['Adjusted Response Time (Min)'];
  H.ACT_RT          = H['Actual Response Time (Min)'];
  H.CONTACTED       = H['Contacted Indicator'];
  H.SALES_REP       = H['Sales Rep'];
  H.MAKE            = H['Make'];
  H.LEAD_ORIG       = H['Lead Origination Date'];
  H.LEAD_MOD        = H['Lead Last Modified Date'];
  H.CUSTOMER        = H['Customer'];
  H.DEALER          = H['Dealer'];
  H.LAST_EMAIL      = H['Last Attempted Email Contact'];
  H.LAST_PHONE      = H['Last Attempted Phone Contact'];
  H.LAST_TEXT       = H['Last Attempted Text Contact Datetime'];
  H.EMAIL           = H['Email'];
  H.DAY_PHONE       = H['Daytime Phone'];
  H.EVE_PHONE       = H['Evening Phone'];
  H.CELL_PHONE      = H['Cell Phone'];
  H.VIN             = H['VIN'];
  H.STOCK_NUM       = H['Stock Number'];
  H.VISIT_ID        = H['Showroom Visit ID'];
  H.ASSIGNED_USER   = H['Assigned User'];
  H.ASSIGNED_GROUP  = H['Assigned User - User Group'];
  H.TO_MANAGER      = H['TO Manager'];
  H.TO_MANAGER_GROUP   = H['TO Manager - User Group'];
  H.CREATED_BY_GROUP   = H['Created By User - User Group'];
  H.COMPLETED_BY_GROUP = H['Completed By User - User Group'];
  H.VISIT_START     = H['Visit Start Date'];
  H.VISIT_RESULT    = H['Visit Result'];
  H.WRITE_UP        = H['Write Up'];
  H.TRADE_APP       = H['Trade Appraisal'];
  H.VISIT_STATUS    = H['Status'];

  return { rows: rows.slice(1).filter(r=>r.length>1), H };
}

// ── Shape guard ───────────────────────────────────────────────────────
export function looksLikeMasterCSV(parsed){
  if (!parsed) return false;
  const H = parsed.H;
  return H.SALES_REP!==undefined && H.VISIT_RESULT!==undefined &&
         H.WRITE_UP!==undefined  && H.CONTACTED!==undefined;
}

// ── Raw date extraction (for date-range picker bounds) ────────────────
export function extractRawDates(rows, H){
  const dates = rows
    .map(r => r[H.LEAD_ORIG] || '')
    .filter(Boolean)
    .map(s => s.slice(0,10))
    .filter(s => /^\d{2}\/\d{2}\/\d{4}/.test(s) || /^\d{4}-\d{2}-\d{2}/.test(s))
    .map(s => {
      if (s.includes('/')){
        const [m,day,y] = s.split('/');
        return y+'-'+m.padStart(2,'0')+'-'+day.padStart(2,'0');
      }
      return s.slice(0,10);
    });
  return [...new Set(dates)].sort();
}

// ── PII column stripping (for filterRows blob) ────────────────────────
const PII_COLUMN_HEADERS = [
  'Customer','Email','Daytime Phone','Day Phone','Cell Phone','Evening Phone',
];

export function sanitizeRows(rows, H){
  const piiIdx = new Set();
  if (H.allHeaders){
    for (let i=0; i<H.allHeaders.length; i++){
      if (PII_COLUMN_HEADERS.includes(H.allHeaders[i])) piiIdx.add(i);
    }
  }
  for (const name of PII_COLUMN_HEADERS){
    if (typeof H[name] === 'number') piiIdx.add(H[name]);
  }
  if (!piiIdx.size) return rows.map(r => r.slice());
  return rows.map(row => {
    const out = row.slice();
    for (const i of piiIdx) if (i < out.length) out[i] = '';
    return out;
  });
}

// ── Core scoring ──────────────────────────────────────────────────────
export function recompute(rows, H, storeId, fromStr, toStr){
  const isAirstreamTab = storeId === 'airstream';

  // Step 1: hard filters
  const filtered = rows.filter(r => {
    const src = (r[H.LEAD_SOURCE]    || '').trim();
    const grp = (r[H.LEAD_SRC_GROUP] || '').trim();
    if (isAirstreamTab){
      if (src.toLowerCase().includes('700')) return false;
      if (grp.toLowerCase().includes('700')) return false;
    } else {
      if (src==='700credithmd' || grp==='700 Credit') return false;
    }
    const isAirstream = isAirstreamLead(r, H);
    if (isAirstreamTab){
      if (!isAirstream) return false;
      if (isAirstreamBadStatus(r, H)) return false;
    } else {
      if (isAirstream) return false;
    }
    const rep = (r[H.SALES_REP]||'').trim();
    if (!rep || !isTrackedRep(storeId, rep)) return false;
    return true;
  });

  // Step 2: global customer dedup (1 lead per customer; extra distinct-unit
  // sales are tracked separately and credited to delivered only — see
  // dedupCustomers above)
  const { leads: dedup, extraSales } = dedupCustomers(filtered, H);

  // Step 3: period classification
  // Parse as local-time datetimes (no 'Z'/offset suffix), not date-only
  // strings. Date-only strings ("2026-06-22") parse as UTC midnight per
  // spec, then .setHours() mutates in local time — on a Central-time
  // machine that silently lands toMs on the PREVIOUS local day's end of
  // day, dropping the entire last day of a bounded range. Appending an
  // explicit local time avoids the UTC round-trip entirely.
  const fromMs = fromStr ? new Date(fromStr + 'T00:00:00.000').getTime() : null;
  const toMs   = toStr   ? new Date(toStr   + 'T23:59:59.999').getTime() : null;
  const inRange = ms => {
    if (isNaN(ms)) return false;
    if (fromMs!==null && ms<fromMs) return false;
    if (toMs  !==null && ms>toMs)   return false;
    return true;
  };
  const noFilter = (fromMs===null && toMs===null);

  const classified = dedup.map(r => {
    const origMs = Date.parse(r[H.LEAD_ORIG]||'');
    const modMs  = Date.parse(r[H.LEAD_MOD] ||'');
    const sold   = isDelivered(r, H);
    const inLeadPeriod  = noFilter ? true : (isNaN(origMs) ? true : inRange(origMs));
    const saleDateMs    = !isNaN(modMs) ? modMs : origMs;
    const inSalePeriod  = sold && (noFilter ? true : inRange(saleDateMs));
    return { row:r, sold, inLeadPeriod, inSalePeriod };
  });

  const keep = classified.filter(c => c.inLeadPeriod || c.inSalePeriod);

  // Step 4: group by rep
  const byRep = {};
  keep.forEach(c => {
    const rep = (c.row[H.SALES_REP]||'').trim();
    (byRep[rep] = byRep[rep]||[]).push(c);
  });

  // Extra distinct-unit sales for an already-counted customer: credited to
  // delivered only (inLeadPeriod:false keeps them out of valid_leads/total_leads).
  extraSales.forEach(r => {
    const modMs2  = Date.parse(r[H.LEAD_MOD] ||'');
    const origMs2 = Date.parse(r[H.LEAD_ORIG]||'');
    const saleDateMs2 = !isNaN(modMs2) ? modMs2 : origMs2;
    const inSalePeriodExtra = noFilter ? true : (!isNaN(saleDateMs2) && inRange(saleDateMs2));
    if (!inSalePeriodExtra) return;
    const rep = (r[H.SALES_REP]||'').trim();
    if (!rep) return;
    (byRep[rep] = byRep[rep]||[]).push({ row:r, sold:true, inLeadPeriod:false, inSalePeriod:true });
  });

  // Step 5: per-rep lead stats
  const leadStats = {};
  Object.entries(byRep).forEach(([rep, classifiedRows]) => {
    const inPeriodLeads       = classifiedRows.filter(c => c.inLeadPeriod);
    const validLeads          = inPeriodLeads.filter(c => !BAD_STATUSES.has((c.row[H.LEAD_STATUS]||'').trim()));
    const deliveriesInPeriod  = classifiedRows.filter(c => c.inSalePeriod);
    const priorPeriodDeliveries = classifiedRows.filter(c => c.inSalePeriod && !c.inLeadPeriod).length;

    const internet = validLeads.filter(c => (c.row[H.LEAD_TYPE]||'').trim()==='Internet');
    const adj = [];
    internet.forEach(c => {
      const v = parseFloat(c.row[H.ADJ_RT]);
      if (isNaN(v)) return;
      if (v>0){ adj.push(v); return; }
      const leadTs   = Date.parse(c.row[H.LEAD_ORIG]||'');
      if (isNaN(leadTs)) return;
      const attempts = [c.row[H.LAST_PHONE],c.row[H.LAST_EMAIL],c.row[H.LAST_TEXT]]
        .map(s => Date.parse(s||'')).filter(t => !isNaN(t));
      if (attempts.length===0) return;
      if (attempts.some(t => t>=leadTs)) adj.push(0);
    });
    const median = a => a.length ? [...a].sort((x,y)=>x-y)[Math.floor(a.length/2)] : null;
    const mA = adj.length>=3 ? median(adj) : null;
    let sp=10, st='N/A';
    if      (mA===null)  { sp=10; st='N/A'; }
    else if (mA<15)      { sp=15; st='Full'; }
    else if (mA<60)      { sp=12; st='Strong'; }
    else if (mA<240)     { sp=8;  st='Partial'; }
    else                 { sp=4;  st='Minimum'; }

    const contacted = validLeads.filter(c => (c.row[H.CONTACTED]||'').trim()==='Yes').length;
    const cr  = validLeads.length ? contacted/validLeads.length : 0;
    const multi = validLeads.filter(c => {
      let cnt=0;
      if (c.row[H.LAST_PHONE]?.trim()) cnt++;
      if (c.row[H.LAST_EMAIL]?.trim()) cnt++;
      if (c.row[H.LAST_TEXT ]?.trim()) cnt++;
      return cnt>=2;
    }).length;
    const mcr = validLeads.length ? multi/validLeads.length : 0;

    leadStats[rep] = {
      valid_leads:validLeads.length,
      bad_leads:inPeriodLeads.length-validLeads.length,
      delivered:deliveriesInPeriod.length,
      prior_period_deliveries:priorPeriodDeliveries,
      internet_leads:internet.length,
      conv_rate:validLeads.length ? deliveriesInPeriod.length/validLeads.length : 0,
      med_adj:mA, speed_pts:sp, speed_tier:st,
      contact_rate:cr, multi_ch_rate:mcr, contact_disc:(cr+mcr)/2,
      scoreable: storeId==='airstream' ? validLeads.length>=1 : validLeads.length>=10,
    };
  });

  const scoreableDels = Object.values(leadStats).filter(d=>d.scoreable).map(d=>d.delivered);
  const maxDel = Math.max(...scoreableDels, 1);
  Object.values(leadStats).forEach(d => d.vol_norm = d.delivered/maxDel);

  // Visit stats
  const visitStats = {};
  filtered.forEach(r => {
    const vid = (r[H.VISIT_ID]    ||'').trim(); if (!vid) return;
    const vr  = (r[H.VISIT_RESULT]||'').trim(); if (vr==='Deleted') return;
    // v4.5: Window visits by Visit Start Date against the same date
    // range as leads/deliveries. Blank/unparseable date → keep (mirrors
    // the lead-date fallback). Keeps this in sync with index.html.
    const visitMs = Date.parse(r[H.VISIT_START]||'');
    const inVisitPeriod = noFilter ? true : (isNaN(visitMs) ? true : inRange(visitMs));
    if (!inVisitPeriod) return;
    const ag  = (r[H.ASSIGNED_GROUP]||'').trim(); if (MGR_GROUPS.has(ag)) return;
    const rep = (r[H.SALES_REP]   ||'').trim(); if (!rep) return;
    const s = visitStats[rep] = visitStats[rep]||{visits:0,write_ups:0,trades:0,user_group:''};
    s.visits++;
    if ((r[H.WRITE_UP]  ||'').trim()==='Y') s.write_ups++;
    if ((r[H.TRADE_APP] ||'').trim()==='Y') s.trades++;
    if (!s.user_group && ag) s.user_group=ag;
  });
  const mxV = Math.max(...Object.values(visitStats).map(d=>d.visits),   1);
  const mxW = Math.max(...Object.values(visitStats).map(d=>d.write_ups), 1);
  Object.values(visitStats).forEach(d => {
    d.wr = d.visits ? d.write_ups/d.visits : 0;
    d.sr = (d.visits/mxV + d.write_ups/mxW) / 2;
  });

  // Airstream per-dealer breakdown
  const perRepDealer  = {};
  const perStoreTotals = {};
  if (isAirstreamTab){
    Object.entries(byRep).forEach(([rep, classifiedRows]) => {
      classifiedRows.forEach(c => {
        const dealer = cleanDealerName((c.row[H.DEALER]||'').trim()) || 'Unknown';
        const inLead = c.inLeadPeriod;
        const valid  = inLead && !BAD_STATUSES.has((c.row[H.LEAD_STATUS]||'').trim());
        const sold   = c.inSalePeriod;
        if (!perRepDealer[rep]) perRepDealer[rep]={};
        const rd = perRepDealer[rep][dealer] = perRepDealer[rep][dealer]||{dealer,leads:0,valid_leads:0,delivered:0};
        if (inLead) rd.leads++;
        if (valid)  rd.valid_leads++;
        if (sold)   rd.delivered++;
        const sd = perStoreTotals[dealer] = perStoreTotals[dealer]||{dealer,leads:0,valid_leads:0,delivered:0,reps:new Set()};
        if (inLead) sd.leads++;
        if (valid)  sd.valid_leads++;
        if (sold)   sd.delivered++;
        if (rep) sd.reps.add(rep);
      });
    });
  }

  // Compose scored rep list
  const reps = [];
  Object.entries(leadStats).forEach(([rep, ls]) => {
    if (!ls.scoreable) return;
    if (BLACKLIST.has(normName(rep)) || isSysAccount(rep)) return;
    const s  = visitStats[rep]||{visits:0,write_ups:0,trades:0,wr:0,sr:0,user_group:''};
    const cp = ls.conv_rate*30;
    const vp = ls.vol_norm*20;
    const spp = ls.speed_pts;
    const conp = ls.contact_disc*15;
    const fp   = s.sr*20;
    const repObj = {
      pos:0, name:rep, group:s.user_group||'Sales', lineup:'Bench',
      composite:+(cp+vp+spp+conp+fp).toFixed(1),
      conv_rate:ls.conv_rate, conv_pts:+cp.toFixed(1),
      delivered:ls.delivered, prior_period_deliveries:ls.prior_period_deliveries||0,
      vol_norm:ls.vol_norm, vol_pts:+vp.toFixed(1),
      med_adj:ls.med_adj, speed_tier:ls.speed_tier, speed_pts:spp,
      internet_leads:ls.internet_leads,
      contact_rate:ls.contact_rate, multi_ch_rate:ls.multi_ch_rate,
      contact_disc:ls.contact_disc, contact_pts:+conp.toFixed(1),
      visits:s.visits, write_ups:s.write_ups, trades:s.trades,
      writeup_rate:s.wr, floor_pts:+fp.toFixed(1),
      valid_leads:ls.valid_leads, bad_leads:ls.bad_leads,
    };
    if (isAirstreamTab && perRepDealer[rep]){
      repObj.byDealer = Object.values(perRepDealer[rep]).sort((a,b)=>b.valid_leads-a.valid_leads);
    }
    reps.push(repObj);
  });

  reps.sort((a,b) => b.composite-a.composite);
  reps.forEach((r,i) => {
    r.pos = i+1;
    if      (i<4) r.lineup='Starter';
    else if (i<9) r.lineup='Lineup';
    else {
      const isDH = (r.conv_rate>=0.18)||(r.contact_disc>=0.90)||(r.writeup_rate>=0.75);
      r.lineup = isDH ? 'DH' : 'Bench';
      if (isDH){
        const str = r.conv_rate>=0.18   ? 'conversion rate ('+pct(r.conv_rate)+')' :
                    r.contact_disc>=0.90 ? 'contact discipline ('+pct(r.contact_disc)+')' :
                                           'write-up rate ('+pct(r.writeup_rate)+')';
        r.bench_note = 'Standout '+str+'. Floor presence or volume is the gap — focus there to move into the Lineup.';
      }
    }
  });

  const result = {
    period: 'Uploaded '+today(), generated: today(),
    totals: {
      total_leads:  reps.reduce((s,r)=>s+r.valid_leads,  0),
      delivered:    reps.reduce((s,r)=>s+r.delivered,    0),
      prior_period_deliveries: reps.reduce((s,r)=>s+(r.prior_period_deliveries||0), 0),
      avg_conv:     reps.length ? reps.reduce((s,r)=>s+r.conv_rate,0)/reps.length : 0,
      total_visits: reps.reduce((s,r)=>s+r.visits,       0),
      total_writeups:reps.reduce((s,r)=>s+r.write_ups,   0),
      total_sales_people: Object.keys(byRep).length,
      max_del: maxDel,
    },
    reps,
  };

  if (isAirstreamTab){
    result.byStore = Object.values(perStoreTotals).map(s => ({
      dealer: s.dealer, leads: s.leads, valid_leads: s.valid_leads,
      delivered: s.delivered,
      conv_rate: s.valid_leads ? s.delivered/s.valid_leads : 0,
      rep_count: s.reps.size,
    })).sort((a,b) => b.delivered-a.delivered || b.leads-a.leads);
  }

  return result;
}
