import { useState, useCallback, useMemo, useRef, useEffect } from "react";

// ━━━ Supabase Proxy Config ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// All Supabase calls go through /api/profile (Vercel serverless function)
// This bypasses India ISP blocks and keeps the Supabase key server-side

function getDeviceId() {
  const KEY = "neofort_device_id";
  try {
    let id = localStorage.getItem(KEY);
    if (!id) { id = crypto.randomUUID ? crypto.randomUUID() : ("xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx").replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16); }); localStorage.setItem(KEY, id); }
    return id;
  } catch { return "unknown"; }
}

async function supabaseUpsertProfile(profile) {
  try {
    const deviceId = getDeviceId();
    const body = { name: profile.name, email: profile.email, mobile: profile.mobile || "", sex: profile.sex || "", designation: profile.designation || "", unit: profile.unit || "", hospital: profile.hospital, city: profile.city, country: profile.country || "", device_id: deviceId };
    const res = await fetch("/api/profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) console.warn("Profile sync failed:", res.status);
  } catch (e) { console.warn("Profile sync failed:", e); }
}

async function supabaseLoadProfile() {
  try {
    const deviceId = getDeviceId();
    // Also try to get email from localStorage for fallback (cache cleared scenario)
    let emailParam = "";
    try { const raw = localStorage.getItem("user_profile"); if (raw) { const p = JSON.parse(raw); if (p.email) emailParam = "&email=" + encodeURIComponent(p.email); } } catch { }
    const res = await fetch("/api/profile?device_id=" + deviceId + emailParam);
    if (!res.ok) return null;
    const rows = await res.json();
    if (rows && rows.length > 0) return rows[0];
  } catch (e) { console.warn("Profile load failed:", e); }
  return null;
}

async function supabaseLoginByEmail(email) {
  try {
    const res = await fetch("/api/profile?email=" + encodeURIComponent(email));
    if (!res.ok) return null;
    const rows = await res.json();
    if (rows && rows.length > 0) return rows[0];
  } catch (e) { console.warn("Email login failed:", e); }
  return null;
}

// ━━━ App Version ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const APP_VERSION = "1.1";
const APP_UPDATED = "12 Sep 2026";   // bump alongside APP_VERSION on each release
const APP_NAME_VERSION = "NeoFORT v" + APP_VERSION;
const SITE_URL = "https://vivekneoaiims.com";
const SITE_LABEL = "vivekneoaiims.com";
// Tags outbound links so site analytics can attribute visits to the app,
// and to the specific placement they came from.
const siteLink = (placement) => SITE_URL +
  "?utm_source=neofort&utm_medium=app&utm_campaign=v" + APP_VERSION +
  "&utm_content=" + placement;

// ━━━ Calculation Engine ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function calculateTPN(inputs) {
  const {
    weightG, tfr, feeds, ivm, aminoAcid, lipid, gir,
    sodium, potassium, calcium, magnesium, po4,
    ivmN5, ivmN2, ivmNS, ivmDex10, ivmDex5,
    feedType, prenanStrength, naSource, aaSource,
    caViaTPN, po4ViaTPN, use5Dex, use25Dex, overfill, celcel, mvi, syringeCount,
    ebmCal100, formulaCal100, ebmProt100, formulaProt100, hmfCalPerG, hmfProtPerG
  } = inputs;
  const wt = weightG / 1000;

  const errors = [];
  if (wt <= 0) errors.push("Weight must be greater than 0.");
  if (feedType === "NPO" && feeds > 0) errors.push("Feed type is NPO but feeds entered as " + feeds + " mL/kg/d. Set feeds to 0 or change feed type.");
  if (feeds > tfr) errors.push("Feeds (" + feeds + " mL/kg/d) exceed total fluid rate (" + tfr + " mL/kg/d). Reduce feeds or increase TFR.");
  const ivmSum = ivmN5 + ivmN2 + ivmNS + ivmDex10 + ivmDex5;
  if (ivm > 0 && ivmSum > ivm) errors.push("IVM breakdown total (" + ivmSum + " mL) exceeds IVM volume (" + ivm + " mL). Correct IVM breakdown or increase IVM.");
  if (ivm === 0 && ivmSum > 0) errors.push("IVM is 0 but sub-volumes total " + ivmSum + " mL. Enter IVM volume or clear breakdown fields.");

  if (wt <= 0) return { errors };

  const I13 = naSource, I14 = aaSource, I12 = caViaTPN ? 1 : 0;
  const F13 = use5Dex ? 1 : 0, F15 = use25Dex ? 1 : 0, F14 = use5Dex ? 0 : 1;
  const I15 = overfill, I16 = celcel, I17 = mvi;

  const naInIVM = ((ivmN5 * 0.031) + (ivmN2 * 0.077) + (ivmNS * 0.154)) / wt;
  const glcInIVM = (ivmDex10 * 0.1) + (ivmDex5 * 0.05);
  const tfv = tfr * wt, feedsMl = feeds * wt, ivfPerKg = tfr - feeds, ivfMl = ivfPerKg * wt;
  const tpnFluid = ivfMl - ivm;
  const tpnGlucose = (gir * wt * 1.44) - glcInIVM;
  const potPhosVol = po4 * wt / 93;
  const kFromPP = 4.4 * potPhosVol / wt;

  if (tpnFluid < 0) errors.push("TPN fluid volume is negative (" + r1(tpnFluid) + " mL). IVM (" + ivm + " mL) exceeds available IV fluid (" + r1(ivfMl) + " mL).");

  const lipidVol = 5 * lipid * wt;
  const mviVol = I17 * wt;
  const celcelVol = I16 * wt;
  const s1Total = lipidVol + mviVol + celcelVol;
  const s1Rate = s1Total / 24;

  const aaVol = 10 * wt * aminoAcid;

  let naVol;
  if (I13 === "CRL" && I14 === "Aminoven") naVol = (sodium - naInIVM) * wt / 3;
  else if (I13 === "CRL" && I14 === "Pentamin") naVol = (sodium - naInIVM - (0.87 * aminoAcid)) * wt / 3;
  else if (I13 === "3% NaCl" && I14 === "Pentamin") naVol = (sodium - naInIVM - (0.87 * aminoAcid)) * wt * 2;
  else naVol = (sodium - naInIVM) * wt * 2;

  let kVol;
  if (I14 === "Aminoven") kVol = (potassium - kFromPP) * (wt / 2);
  else kVol = (potassium - (kFromPP + (3 * aminoAcid / 20))) * (wt / 2);

  const caVol = I12 === 1 ? wt * calcium / 9.3 : 0;
  const mgVol = magnesium * wt / 4;
  const ppVolInTPN = po4ViaTPN ? potPhosVol : 0;

  const fluidForGlc = (tpnFluid - lipidVol - aaVol - naVol - kVol - caVol - ppVolInTPN) - mviVol - celcelVol;

  if (fluidForGlc < 0 && tpnFluid >= 0) errors.push("Insufficient fluid for dextrose (" + r1(fluidForGlc) + " mL remaining). Reduce component doses or increase TFR.");

  let F16;
  if (((0.1 * fluidForGlc * F14) + (0.05 * fluidForGlc * F13)) > tpnGlucose) F16 = 0;
  else F16 = F15 === 1 ? 0 : 1;

  const num = ((5 * fluidForGlc * F16) + (2.5 * fluidForGlc * F15)) - (10 * tpnGlucose);
  const den = ((5 * F16) + (2.5 * F15)) - ((0.5 * F13) + F14);
  const dexLowVol = den !== 0 ? num / den : 0;
  let dexHighVol;
  if (F15 === 0 && ((0.1 * fluidForGlc * F14) + (0.05 * fluidForGlc * F13)) > tpnGlucose) dexHighVol = 0;
  else dexHighVol = fluidForGlc - dexLowVol;

  const dexLowName = F13 === 1 ? "5% Dextrose" : "10% Dextrose";
  const dexHighName = F15 === 1 ? "25% Dextrose" : "50% Dextrose";

  if (dexLowVol < -0.05) errors.push(dexLowName + " volume is negative (" + r1(dexLowVol) + " mL). Try switching dextrose concentrations or adjust GIR.");
  if (dexHighVol < -0.05) errors.push(dexHighName + " volume is negative (" + r1(dexHighVol) + " mL). Glucose ordered is too low for this fluid volume \u2014 increase GIR, reduce TFR, or use a weaker low dextrose.");

  // Fluid-balance guard. dexLowVol + dexHighVol must fill fluidForGlc exactly.
  // When the glucose load is too small to be carried even at the lowest available
  // dextrose strength, the solver zeroes the high dextrose and the leftover volume
  // would otherwise vanish silently, under-fluiding the baby. Fail loudly instead.
  const dexTotal = dexLowVol + dexHighVol;
  const fluidGap = fluidForGlc - dexTotal;
  if (fluidForGlc > 0 && fluidGap > 0.05) {
    const reqPct = tpnGlucose * 100 / fluidForGlc;
    const lowPct = F13 === 1 ? "5%" : "10%";
    const deliveredTFR = tfr - (fluidGap / wt);
    errors.push(
      "Dextrose cannot fill the prescribed volume. Fluid for glucose is " + r1(fluidForGlc) +
      " mL but only " + r1(tpnGlucose) + " g dextrose is needed, i.e. " + reqPct.toFixed(1) +
      "% \u2014 weaker than the lowest strength selected (" + lowPct + "). " + r1(fluidGap) +
      " mL/d would be unaccounted for: baby would receive " + r1(deliveredTFR) + " mL/kg/d instead of " +
      tfr + " mL/kg/d. " +
      (F13 === 1
        ? "Reduce TFR, increase GIR, or give the deficit as sterile water and document it."
        : "Set Low dextrose to 5%, or reduce TFR / increase GIR.")
    );
  }

  if (errors.length > 0) return { errors };

  const s2TotalFull = aaVol + naVol + kVol + caVol + mgVol + dexLowVol + dexHighVol;
  const s2RateFull = s2TotalFull / 24;
  const isPerDay = I15 > 1;
  const ref50 = 50;

  const oN = (0.26 * lipidVol) + (aaVol * 0.885) + (dexLowVol * 0.555) + (dexHighVol * 2.78) + (naVol * 1.027) + (kVol * 4);
  const oD = lipidVol + aaVol + naVol + kVol + dexLowVol + dexHighVol;
  const cnr = aminoAcid > 0 ? 6.25 * ((4.9 * gir) + (9 * lipid)) / aminoAcid : 0;
  const dexPct = s2TotalFull > 0 ? tpnGlucose * 100 / s2TotalFull : 0;
  const fCal = feeds * (feedType === "NPO" ? 0 : (feedType === "Formula" ? formulaCal100 / 100 : ebmCal100 / 100));
  const pCal = feeds * (feedType === "NPO" ? 0 : (prenanStrength === "None" ? 0 : (prenanStrength === "Quarter" ? hmfCalPerG / 100 : (prenanStrength === "Half" ? hmfCalPerG / 50 : hmfCalPerG / 25))));
  const fProt = feeds * (feedType === "NPO" ? 0 : (feedType === "Formula" ? formulaProt100 / 100 : ebmProt100 / 100));
  const pProt = feeds * (feedType === "NPO" ? 0 : (prenanStrength === "None" ? 0 : (prenanStrength === "Quarter" ? hmfProtPerG / 100 : (prenanStrength === "Half" ? hmfProtPerG / 50 : hmfProtPerG / 25))));

  const warnings = [];
  if (dexPct > 12.5) warnings.push("Dextrose " + dexPct.toFixed(1) + "% - consider central line.");
  if (naVol < 0) warnings.push("Na volume slightly negative - Na via IVM/Pentamin may exceed target.");

  const naLabel = I13 === "CRL" ? "Conc. RL" : "3% NaCl";
  const aaLabel = I14 === "Aminoven" ? "10% Aminoven" : "10% Pentamin";

  const mkS2 = (l, v, refT) => {
    if (isPerDay) return { l, v, adj: v * I15 };
    return { l, v, p50: refT > 0 ? v * ref50 / refT : 0 };
  };

  const s1Items = [
    { l: "20% Lipid", v: lipidVol },
    { l: "MVI", v: mviVol },
    { l: "Celcel", v: celcelVol },
  ];
  const s1Show50 = !isPerDay && s1Total > 50;
  if (s1Show50) s1Items.forEach(it => { it.p50 = s1Total > 0 ? it.v * ref50 / s1Total : 0 });
  if (isPerDay) s1Items.forEach(it => { it.adj = it.v * I15 });

  let s2Items, s3Items = null, s2Total, s3Total, s2Rate, s3Rate;
  if (syringeCount === 3) {
    s2Total = aaVol + naVol + kVol + caVol + mgVol + ppVolInTPN;
    s3Total = dexLowVol + dexHighVol;
    s2Rate = s2Total / 24; s3Rate = s3Total / 24;
    s2Items = [
      mkS2(aaLabel, aaVol, s2Total), mkS2(naLabel, naVol, s2Total),
      mkS2("15% KCl", kVol, s2Total), mkS2("10% Ca Gluconate", caVol, s2Total),
      mkS2("50% MgSO\u2084", mgVol, s2Total), mkS2("KPO\u2084", ppVolInTPN, s2Total),
    ];
    s3Items = [mkS2(dexLowName, dexLowVol, s3Total), mkS2(dexHighName, dexHighVol, s3Total)];
  } else {
    s2Total = s2TotalFull + ppVolInTPN; s2Rate = s2Total / 24;
    s2Items = [
      mkS2(aaLabel, aaVol, s2Total), mkS2(naLabel, naVol, s2Total),
      mkS2("15% KCl", kVol, s2Total), mkS2("10% Ca Gluconate", caVol, s2Total),
      mkS2("50% MgSO\u2084", mgVol, s2Total), mkS2("KPO\u2084", ppVolInTPN, s2Total),
      mkS2(dexLowName, dexLowVol, s2Total), mkS2(dexHighName, dexHighVol, s2Total),
    ];
  }

  return {
    s1: { items: s1Items, total: s1Total, rate: s1Rate, show50: s1Show50, isPerDay },
    s2: { items: s2Items, total: s2Total, rate: s2Rate },
    s3: s3Items ? { items: s3Items, total: s3Total, rate: s3Rate } : null,
    sep: { pp: po4ViaTPN ? 0 : potPhosVol, ca: I12 === 0 ? wt * calcium / 9.3 : 0 },
    mon: {
      tfv, feeds: feedsMl, ivfKg: ivfPerKg, ivfMl, tpn: tpnFluid, tpnG: tpnGlucose, gFluid: fluidForGlc,
      dex: dexPct, cnr, osm: oD > 0 ? (oN / oD) * 1000 : 0,
      cal: (aminoAcid * 4) + (lipid * 9) + (gir * 5) + fCal + pCal,
      prot: aminoAcid + fProt + pProt, naIVM: naInIVM, gIVM: glcInIVM, kPP: kFromPP
    },
    isPerDay, overfill: I15, warnings, errors: null
  };
}

const r1 = v => Math.round(v * 10) / 10;
const fV = v => r1(v).toFixed(1);

// ━━━ Themes ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const TH = {
  light: { bg: "#f0f2f5", card: "#fff", border: "#dfe3ea", accent: "#0077cc", accentDim: "rgba(0,119,204,.07)", accentText: "#005fa3", green: "#0f8a4f", amber: "#c47f17", amberDim: "rgba(196,127,23,.07)", red: "#cc3333", redDim: "rgba(204,51,51,.06)", redBright: "#dc2626", redBg: "#fde8e8", redBorder: "#f5c6c6", purple: "#7e3bbd", blue: "#2563eb", blueBg: "rgba(37,99,235,.08)", t1: "#1a2233", t2: "#4a5568", t3: "#8896a8", inp: "#f7f9fb", inpBorder: "#cdd5de", inpFocus: "#0077cc", btnGrad: "linear-gradient(135deg,#0077cc,#5b5fd6)", shadow: "0 1px 4px rgba(0,0,0,.06)", stepBg: "#edf0f4", stepHover: "#dfe3ea", navBg: "#fff", navBorder: "#dfe3ea", overlay: "rgba(0,0,0,.3)" },
  classic: { bg: "#e8e4dc", card: "#faf7f2", border: "#cec9bf", accent: "#a0522d", accentDim: "rgba(160,82,45,.08)", accentText: "#8b4513", green: "#2e7d32", amber: "#bf6c00", amberDim: "rgba(191,108,0,.07)", red: "#b71c1c", redDim: "rgba(183,28,28,.06)", redBright: "#c62828", redBg: "#fce4e4", redBorder: "#e8b4b4", purple: "#5e35b1", blue: "#1565c0", blueBg: "rgba(21,101,192,.08)", t1: "#2c2520", t2: "#5d5550", t3: "#9e9690", inp: "#faf7f2", inpBorder: "#c8c2b8", inpFocus: "#a0522d", btnGrad: "linear-gradient(135deg,#a0522d,#7b2d8e)", shadow: "0 1px 3px rgba(0,0,0,.06)", stepBg: "#ede9e2", stepHover: "#ddd8cf", navBg: "#faf7f2", navBorder: "#cec9bf", overlay: "rgba(0,0,0,.3)" },
  dark: { bg: "#0b1120", card: "#131d30", border: "#1f3050", accent: "#38bdf8", accentDim: "rgba(56,189,248,.1)", accentText: "#38bdf8", green: "#34d399", amber: "#fbbf24", amberDim: "rgba(251,191,36,.1)", red: "#f87171", redDim: "rgba(248,113,113,.08)", redBright: "#ef4444", redBg: "rgba(239,68,68,.15)", redBorder: "rgba(239,68,68,.35)", purple: "#a78bfa", blue: "#60a5fa", blueBg: "rgba(96,165,250,.12)", t1: "#e2e8f0", t2: "#8b9fc0", t3: "#556880", inp: "#0d1528", inpBorder: "#1f3050", inpFocus: "#38bdf8", btnGrad: "linear-gradient(135deg,#38bdf8,#818cf8)", shadow: "0 2px 8px rgba(0,0,0,.25)", stepBg: "#182440", stepHover: "#1f3050", navBg: "#131d30", navBorder: "#1f3050", overlay: "rgba(0,0,0,.6)" }
};

// ━━━ Logo (theme-aware, uses actual brand images with transparent bg) ━━━━━━━
const LOGO_LIGHT = "data:image/png;base64,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";
const ICO_TPN = "data:image/png;base64,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";
const ICO_GIR = "data:image/png;base64,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";
const ICO_NUT = "data:image/png;base64,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";
// Theme-aware transparent PNGs built from the updated droplet mark. The compact
// (header) variant
// clips off the tagline strip rather than loading a second, opaque asset; the
// old *_C JPEGs were flattened onto solid black, which showed as a black box.
const LOGO_DARK = "data:image/png;base64,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";
const LOGO_AR = 196 / 600, LOGO_CLIP = 0.756;
function Logo({ T, width = 200, compact = false }) {
  const src = T === TH.dark ? LOGO_DARK : LOGO_LIGHT;
  // display:block removes the inline descender gap inside the compact clip box,
  // but block elements ignore the parent's textAlign, so the full-size variant
  // needs margin:0 auto to stay centred in the drawer and the profile screen.
  if (!compact) return <img src={src} alt="NeoFORT" style={{ width, height: "auto", display: "block", margin: "0 auto" }} />;
  return <div style={{ width, height: Math.round(width * LOGO_AR * LOGO_CLIP), overflow: "hidden" }}>
    <img src={src} alt="NeoFORT" style={{ width, height: "auto", display: "block" }} />
  </div>;
}
// ━━━ Help Data ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const HELP = {
  weight: "Dosing weight in grams (current weight, NOT birth weight). Used for all per-kg calculations.",
  tfr: "TFR (Total Fluid Rate): Total fluids planned for the day in mL/kg/day - includes feeds + TPN + IV medications.",
  feeds: "Enteral feeds planned in mL/kg/day. Enter 0 if baby is NPO (nil per oral).",
  ivm: "IVM (IV Medications): Total daily volume of all IV meds in mL (antibiotics, inotropes, flushes etc).",
  feedType: "NPO = nil per oral (no feeds).\nEBM = expressed breast milk.\nPDHM = pasteurized donor human milk.\nFormula = standard infant formula.",
  hmf: "HMF (Human Milk Fortifier) or PTF (Protein-Targeted Fortifier):\nAdds calories & protein to breast milk.\nQuarter = 1g per 100 mL feeds\nHalf = 1g per 50 mL\nFull = 1g per 25 mL\nLabel auto-selected based on protein content in Settings.",
  aminoAcid: "Amino acids: Protein target in g/kg/day via TPN.\nUsual: Start 1.5-2, advance by 0.5-1 daily to 3-4 g/kg/day.",
  lipid: "Lipids: Fat target in g/kg/day via 20% Intralipid.\nUsual: Start 1, advance to 3-4 g/kg/day.\nGiven in Syringe 1.",
  gir: "GIR (Glucose Infusion Rate): Target glucose delivery in mg/kg/min.\nUsual range: 4-12 mg/kg/min.\nFormula: (Dex% x Rate) / (Wt x 6)",
  na: "Na (Sodium): Requirement in mEq/kg/day.\nUsual: 2-5 mEq/kg/day.\nAdjusted based on serum sodium levels.",
  k: "K (Potassium): Requirement in mEq/kg/day.\nUsual: 2-3 mEq/kg/day.\nIncludes K coming from PotPhos (4.4 mEq/mL).",
  ca: "Ca (Calcium): Requirement in mg/kg/day.\nUsual: 40-80 mg/kg/day.\nCan be in TPN syringe or separate infusion.",
  po4: "PO4 (Phosphate): Via Potassium Phosphate.\n1 mL PotPhos = 93 mg PO4 + 4.4 mEq K.\nGive in >=20x dilution.",
  mg: "Mg (Magnesium): Via 50% MgSO4.\nUsual: 0.25-0.5 mEq/kg/day.\nOften 0 if serum Mg is normal.",
  ivmBreak: "Break down total IVM volume by fluid type so calculator subtracts Na & glucose already going via IV medications.\nN/5 = 0.2% NS, N/2 = 0.45% NS, NS = 0.9% NaCl, 5% Dex = 0.05 g/mL glucose, 10% Dex = 0.1 g/mL glucose.",
  aaSource: "Aminoven: Pure amino acids.\nPentamin: Contains 8.7 mEq Na + 1.5 mEq K per 100 mL - calculator auto-adjusts Na/K.",
  naSource: "3% NaCl: Standard (0.51 mEq Na/mL).\nCRL (Conc. Ringer Lactate): Alternative, ~1.5 mEq Na/mL.",
  dex: "Dextrose concentrations for mixing.\n10% + 50% is most common.\nUse 5% + 25% for lower GIR needs.",
  caInTPN: "ON: Ca Gluconate added to Syringe 2.\nOFF: 10% Ca Gluconate given as separate infusion.",
  po4InTPN: "ON: Potassium Phosphate (KPO4) added to Syringe 2.\nOFF: KPO4 given as separate infusion.\nDefault: OFF (separate).",
  celcel: "Celcel (trace elements): Usual 1 mL/kg/day.\nAdd after 2 weeks of age.\nAvoid in cholestasis.",
  mviHelp: "MVI (Multivitamin): Usual 1 mL/kg/day.\nAdded to Syringe 1 (lipid syringe).",
  overfill: "Overfill factor:\n= 1: Make in 50 mL syringe (shows Per 50 mL).\n> 1: Make full day volume with extra for priming.\n1.1 = 10% extra, 1.2 = 20% extra.\nShows Volume vs Adjusted Volume.",
  syringe: "2 syringes: S1 = Lipid, S2 = Protein + Electrolytes + Dextrose.\n3 syringes: S1 = Lipid, S2 = Protein + Electrolytes, S3 = Dextrose only.",
  girFluid: "Fluid available for dextrose in mL/kg/day.\nIn TPN context this equals the glucose fluid volume after subtracting lipids, amino acids, electrolytes etc.",
  girDex: "Select dextrose concentrations:\n10% only = single concentration, GIR is fixed.\nMix two concentrations to target a specific GIR.\n10% + 50% is most common.\n5% + 25% for very low GIR.",
};

// ━━━ Info Tooltip ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function InfoBtn({ id, T, oi, soi }) {
  const isOpen = oi === id;
  const btnRef = useRef(null);
  const [tipPos, setTipPos] = useState({ top: 0, left: 0 });
  const TIP_W = 220, MARGIN = 8;
  const calcPos = () => {
    if (!btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    let left = r.left;
    if (left + TIP_W > vw - MARGIN) left = vw - TIP_W - MARGIN;
    if (left < MARGIN) left = MARGIN;
    setTipPos({ top: r.bottom + 6, left });
  };
  const show = () => { calcPos(); if (soi) soi(id); };
  const hide = () => { if (soi && isOpen) soi(null); };
  const toggle = e => {
    e.preventDefault(); e.stopPropagation();
    if (!isOpen) calcPos();
    if (soi) soi(isOpen ? null : id);
  };
  return <span style={{ position: "relative", display: "inline-flex" }}
    onMouseEnter={show} onMouseLeave={hide}>
    <button ref={btnRef} onClick={toggle} onMouseDown={e => e.stopPropagation()}
      style={{ width: 15, height: 15, borderRadius: 8, fontSize: 8, fontWeight: 800, fontStyle: "italic", background: isOpen ? T.accentDim : "transparent", color: isOpen ? T.accentText : T.t3, border: "1px solid " + (isOpen ? T.accent + "66" : T.border), cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", marginLeft: 4, fontFamily: "Georgia,serif", padding: 0 }}>i</button>
    {isOpen && <div onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}
      style={{ position: "fixed", top: tipPos.top, left: tipPos.left, zIndex: 9999, width: TIP_W, padding: "12px 14px", background: T.card, border: "1.5px solid " + T.accent + "44", borderRadius: 12, boxShadow: "0 8px 32px rgba(0,0,0,.22)", fontSize: 11, color: T.t2, lineHeight: 1.6, fontWeight: 400, fontStyle: "normal", whiteSpace: "pre-line" }}>{HELP[id] || "No info."}</div>}
  </span>;
}

// ━━━ Input Components ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function NI({ label, unit, value, onChange, step = .1, min = 0, max, T, info, oi, soi }) {
  // draft holds the raw text while the field is focused, so partial entries
  // ("", "-", "1.") stay typeable. null means "show the canonical value".
  const [draft, setDraft] = useState(null);
  const selRef = useRef(false);
  const clamp = n => { let v = n; if (min != null) v = Math.max(v, min); if (max != null) v = Math.min(v, max); return v };
  const inc = () => onChange(clamp(+(value + step).toFixed(4)));
  const dec = () => onChange(clamp(+(value - step).toFixed(4)));
  const edit = raw => {
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) { setDraft(raw); onChange(clamp(0)); return }
    const c = clamp(n);
    onChange(c);
    // Rewrite the visible text whenever it disagrees with the accepted value,
    // e.g. "0780" -> "780", "99999" -> max, "-5" -> min. Keeps the display
    // honest; React alone will not do this for type="number".
    setDraft(raw.endsWith(".") || String(c) === raw ? raw : String(c));
  };
  return <div style={{ flex: "1 1 0", minWidth: 0 }}>
    <div style={{ display: "flex", alignItems: "baseline", marginBottom: 3, minHeight: 15, gap: 3 }}>
      <label style={{ fontSize: 10, color: T.t3, fontWeight: 600, letterSpacing: ".03em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flexShrink: 1, minWidth: 0 }}>{label}</label>
      {unit && <span style={{ fontSize: 8.5, color: T.t3, fontWeight: 400, opacity: 0.75, whiteSpace: "nowrap", flexShrink: 0 }}>({unit})</span>}
      {info && <InfoBtn id={info} T={T} oi={oi} soi={soi} />}
    </div>
    <div style={{ display: "flex", alignItems: "center", background: T.inp, borderRadius: 8, border: "1.5px solid " + T.inpBorder, height: 38, overflow: "hidden" }}>
      <input type="number" value={draft !== null ? draft : String(value)} onChange={e => edit(e.target.value)} step={step} min={min} max={max}
        style={{ width: 0, flex: "1 1 auto", padding: "0 4px 0 6px", fontSize: 15, fontWeight: 700, background: "transparent", border: "none", color: T.t1, outline: "none", fontFamily: "'JetBrains Mono',monospace", minWidth: 0 }}
        onFocus={e => { selRef.current = true; setDraft(String(value)); e.currentTarget.parentElement.style.borderColor = T.inpFocus; e.currentTarget.select(); }}
        onMouseUp={e => { if (selRef.current) { selRef.current = false; e.preventDefault() } }}
        onBlur={e => { selRef.current = false; setDraft(null); e.currentTarget.parentElement.style.borderColor = T.inpBorder }} />
      <div style={{ display: "flex", flexDirection: "column", borderLeft: "1px solid " + T.inpBorder, height: "100%", flexShrink: 0, width: 24 }}>
        <button onClick={inc} style={{ flex: 1, background: T.stepBg, border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: T.t2, borderBottom: ".5px solid " + T.inpBorder, padding: 0 }} onMouseEnter={e => e.currentTarget.style.background = T.stepHover} onMouseLeave={e => e.currentTarget.style.background = T.stepBg}><svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 6.5L5 3.5L8 6.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" /></svg></button>
        <button onClick={dec} style={{ flex: 1, background: T.stepBg, border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: T.t2, padding: 0 }} onMouseEnter={e => e.currentTarget.style.background = T.stepHover} onMouseLeave={e => e.currentTarget.style.background = T.stepBg}><svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" /></svg></button>
      </div>
    </div>
  </div>;
}
function Row({ children }) {
  const c = Array.isArray(children) ? children.filter(Boolean).length : 1;
  // Use minmax so columns can't shrink below a readable size; on tiny screens they wrap
  const cols = c === 3 ? "repeat(3, minmax(0, 1fr))" : c === 2 ? "repeat(2, minmax(0, 1fr))" : "1fr";
  return <div style={{ display: "grid", gridTemplateColumns: cols, gap: 8, marginBottom: 8, alignItems: "end" }}>{children}</div>;
}
function Pills({ label, options, value, onChange, T, info, oi, soi }) {
  return <div style={{ flex: "1 1 0", minWidth: 0 }}>
    <div style={{ display: "flex", alignItems: "center", marginBottom: 4, minHeight: 15 }}>
      <label style={{ fontSize: 10, color: T.t3, fontWeight: 600, letterSpacing: ".03em" }}>{label}</label>
      {info && <InfoBtn id={info} T={T} oi={oi} soi={soi} />}
    </div>
    <div style={{ display: "flex", gap: 2, background: T.inp, borderRadius: 8, padding: 2, height: 38, alignItems: "stretch" }}>
      {options.map(o => { const v = o.value ?? o, l = o.label ?? o, on = value === v; return <button key={v} onClick={() => onChange(v)} style={{ flex: 1, fontSize: 10, fontWeight: on ? 700 : 500, background: on ? T.accentDim : "transparent", color: on ? T.accentText : T.t3, border: on ? "1px solid " + T.accent + "33" : "1px solid transparent", borderRadius: 6, cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "flex", alignItems: "center", justifyContent: "center" }}>{l}</button> })}
    </div>
  </div>;
}
function Tog({ label, value, onChange, T, info, oi, soi }) {
  return <div style={{ flex: "1 1 0", minWidth: 0 }}>
    <div style={{ display: "flex", alignItems: "center", marginBottom: 4, minHeight: 15 }}>
      <label style={{ fontSize: 10, color: T.t3, fontWeight: 600, letterSpacing: ".03em" }}>{label}</label>
      {info && <InfoBtn id={info} T={T} oi={oi} soi={soi} />}
    </div>
    <div style={{ height: 38, display: "flex", alignItems: "center", background: T.inp, borderRadius: 8, padding: "0 10px", border: "1.5px solid " + T.inpBorder }}>
      <button onClick={() => onChange(!value)} style={{ width: 38, height: 20, borderRadius: 10, border: "none", cursor: "pointer", background: value ? T.accent : T.inpBorder, position: "relative", transition: "background .2s", flexShrink: 0 }}><div style={{ width: 16, height: 16, borderRadius: 8, background: value ? "#fff" : T.t3, position: "absolute", top: 2, left: value ? 20 : 2, transition: "all .2s" }} /></button>
      <span style={{ fontSize: 11, color: value ? T.accentText : T.t3, marginLeft: 8, fontWeight: 600 }}>{value ? "Yes" : "No"}</span>
    </div>
  </div>;
}
function CaPConc({ caVal, onCaChange, pVal, onPChange, T }) {
  const inc = () => { const nc = +(caVal + 1).toFixed(4); onCaChange(nc); onPChange(+(nc / 2).toFixed(4)); };
  const dec = () => { const nc = Math.max(+(caVal - 1).toFixed(4), 0); onCaChange(nc); onPChange(+(nc / 2).toFixed(4)); };
  return <div style={{ flex: "1 1 0", minWidth: 0 }}>
    <div style={{ display: "flex", alignItems: "baseline", marginBottom: 3, minHeight: 15, gap: 3 }}>
      <label style={{ fontSize: 10, color: T.t3, fontWeight: 600, letterSpacing: ".03em", whiteSpace: "nowrap" }}>Ca/P conc.</label>
      <span style={{ fontSize: 8.5, color: T.t3, fontWeight: 400, opacity: 0.75, whiteSpace: "nowrap", flexShrink: 0 }}>(mg/mL)</span>
    </div>
    <div style={{ display: "flex", alignItems: "center", background: T.inp, borderRadius: 8, border: "1.5px solid " + T.inpBorder, height: 38, overflow: "hidden" }}>
      <div style={{ flex: "1 1 auto", display: "flex", alignItems: "center", justifyContent: "center", padding: "0 6px", fontSize: 15, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", color: T.t1, gap: 2, minWidth: 0 }}>
        <span>{caVal}</span><span style={{ color: T.t3, fontWeight: 400 }}>/</span><span>{pVal}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", borderLeft: "1px solid " + T.inpBorder, height: "100%", flexShrink: 0, width: 24 }}>
        <button onClick={inc} style={{ flex: 1, background: T.stepBg, border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: T.t2, borderBottom: ".5px solid " + T.inpBorder, padding: 0 }} onMouseEnter={e => e.currentTarget.style.background = T.stepHover} onMouseLeave={e => e.currentTarget.style.background = T.stepBg}><svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 6.5L5 3.5L8 6.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" /></svg></button>
        <button onClick={dec} style={{ flex: 1, background: T.stepBg, border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: T.t2, padding: 0 }} onMouseEnter={e => e.currentTarget.style.background = T.stepHover} onMouseLeave={e => e.currentTarget.style.background = T.stepBg}><svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" /></svg></button>
      </div>
    </div>
  </div>;
}
function Sec({ title, children, open, onToggle, T }) {
  return <div style={{ background: T.card, borderRadius: 12, border: "1px solid " + T.border, marginBottom: 8, boxShadow: T.shadow }}>
    <button onClick={onToggle} style={{ width: "100%", display: "flex", alignItems: "center", padding: "11px 12px", background: "transparent", border: "none", cursor: "pointer", textAlign: "left" }}>
      <span style={{ flex: 1, fontSize: 14, fontWeight: 700, color: T.t1 }}>{title}</span>
      <svg width="16" height="16" viewBox="0 0 16 16" style={{ transform: open ? "rotate(0)" : "rotate(-90deg)", transition: "transform .2s", color: T.t3 }}><path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" /></svg>
    </button>
    {open && <div style={{ padding: "0 12px 12px" }}>{children}</div>}
  </div>;
}

// ━━━ Syringe Card ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function SyrCard({ title, tag, items, total, rate, hasCol2, col2Label, alignWith3Col, color, T }) {
  const vis = items.filter(it => r1(Math.abs(it.v)) > 0);
  if (vis.length === 0) return null;
  const use3 = hasCol2 || alignWith3Col;
  const gc = use3 ? "1fr 80px 88px" : "1fr 80px";
  const col2Key = vis[0]?.p50 != null ? "p50" : (vis[0]?.adj != null ? "adj" : null);

  return <div className="syr-card" style={{ background: T.card, borderRadius: 12, marginBottom: 8, border: "1px solid " + color + "25", overflow: "hidden", boxShadow: T.shadow }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", background: color + "0a", borderBottom: "1px solid " + color + "18" }}>
      <div style={{ width: 28, height: 28, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", background: color + "15", border: "1.5px solid " + color + "40", fontSize: 11, fontWeight: 800, color, flexShrink: 0 }}>{tag}</div>
      <div style={{ flex: 1, fontSize: 13, fontWeight: 700, color: T.t1 }}>{title}</div>
    </div>
    <div style={{ display: "grid", gridTemplateColumns: gc, padding: "6px 12px 0" }}>
      <span />
      <span style={{ fontSize: 9, color: T.t3, fontWeight: 700, textTransform: "uppercase", textAlign: "right" }}>Volume</span>
      {hasCol2 && <span style={{ fontSize: 9, color: T.t3, fontWeight: 700, textTransform: "uppercase", textAlign: "right" }}>{col2Label}</span>}
      {alignWith3Col && !hasCol2 && <span />}
    </div>
    <div style={{ padding: "2px 12px 10px" }}>
      {vis.map((it, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: gc, alignItems: "center", padding: "5px 0", borderBottom: i < vis.length - 1 ? "1px solid " + T.border + "44" : "none" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}><div style={{ width: 5, height: 5, borderRadius: 3, background: color, flexShrink: 0 }} /><span style={{ fontSize: 12, color: T.t2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.l}</span></div>
          <div style={{ textAlign: "right" }}><span style={{ fontSize: 13, fontWeight: 600, fontFamily: "'JetBrains Mono',monospace", color: T.t1 }}>{fV(it.v)}</span><span style={{ fontSize: 9, color: T.t3, marginLeft: 2 }}>mL</span></div>
          {hasCol2 && col2Key && <div style={{ textAlign: "right" }}><span style={{ fontSize: 13, fontWeight: 600, fontFamily: "'JetBrains Mono',monospace", color: T.t1 }}>{fV(it[col2Key] || 0)}</span><span style={{ fontSize: 9, color: T.t3, marginLeft: 1 }}>mL</span></div>}
          {alignWith3Col && !hasCol2 && <span />}
        </div>))}
      <div style={{ display: "grid", gridTemplateColumns: gc, alignItems: "baseline", marginTop: 6, paddingTop: 8, borderTop: "1.5px solid " + color + "30" }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: T.t1 }}>Total</span>
        <div style={{ textAlign: "right" }}>
          <span style={{ fontSize: 17, fontWeight: 800, color, fontFamily: "'JetBrains Mono',monospace" }}>{fV(total)}</span>
          <span style={{ fontSize: 10, color: T.t3, marginLeft: 2 }}>mL</span>
        </div>
        <div style={{ textAlign: "right" }}>
          <span style={{ fontSize: 11, color, marginRight: 1 }}>@</span>
          <span style={{ fontSize: 17, fontWeight: 800, color, fontFamily: "'JetBrains Mono',monospace" }}>{rate.toFixed(2)}</span>
          <span style={{ fontSize: 10, color, marginLeft: 2 }}>mL/hr</span>
        </div>
      </div>
    </div>
  </div>;
}

function Metric({ label, val, unit, color, warn, T }) {
  const bg = warn === "mid" ? T.amberDim : color + "0c", tc = warn === "mid" ? T.amber : color;
  return <div style={{ background: bg, borderRadius: 10, padding: "8px 10px", border: "1px solid " + tc + "20", flex: "1 1 calc(33.3% - 5px)", minWidth: 88 }}>
    <div style={{ fontSize: 9, color: T.t3, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 3 }}>{label}</div>
    <span style={{ fontSize: 16, fontWeight: 700, color: tc, fontFamily: "'JetBrains Mono',monospace" }}>{val}</span><span style={{ fontSize: 9, color: T.t3, marginLeft: 3 }}>{unit}</span>
  </div>;
}

// ━━━ Storage ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const FACTORY = { weightG: 1000, tfr: 100, feeds: 0, ivm: 0, aminoAcid: 3, lipid: 3, gir: 6, sodium: 3, potassium: 2, calcium: 0, magnesium: 0, po4: 0, ivmN5: 0, ivmN2: 0, ivmNS: 0, ivmDex10: 0, ivmDex5: 0, feedType: "NPO", prenanStrength: "None", naSource: "3% NaCl", aaSource: "Aminoven", caViaTPN: true, po4ViaTPN: false, use5Dex: false, use25Dex: false, overfill: 1, celcel: 0, mvi: 1, syringeCount: 2, ebmCal100: 67, formulaCal100: 78, ebmProt100: 1.1, formulaProt100: 1.9, hmfCalPerG: 4, hmfProtPerG: 0.3 };
// ━━━ Storage helpers (localStorage first, window.storage fallback) ━━━━━━━━━━
async function storeGet(key) {
  try { const v = localStorage.getItem(key); if (v) return v; } catch { }
  try { const r = await window.storage.get(key); if (r?.value) { try { localStorage.setItem(key, r.value) } catch { } return r.value; } } catch { }
  return null;
}
async function storeSet(key, value) {
  try { localStorage.setItem(key, value) } catch { }
  try { await window.storage.set(key, value) } catch { }
}

function useStore(key, fb) {
  const [v, setV] = useState(fb); const [ld, setLd] = useState(false);
  useEffect(() => {
    (async () => {
      const raw = await storeGet(key);
      if (raw) try { setV(JSON.parse(raw)) } catch { }
      setLd(true);
    })()
  }, [key]);
  const save = useCallback(async nv => { setV(nv); await storeSet(key, JSON.stringify(nv)); }, [key]);
  return [v, save, ld];
}
function todayStr() { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0") }

// ━━━ Hamburger ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function HMenu({ open, onClose, onNav, T }) {
  if (!open) return null;
  return <><div onClick={onClose} style={{ position: "fixed", inset: 0, background: T.overlay, zIndex: 200 }} />
    <div style={{ position: "fixed", top: 0, left: 0, bottom: 0, width: 280, background: T.card, zIndex: 201, boxShadow: "4px 0 24px rgba(0,0,0,.15)", animation: "slideIn .25s ease", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "16px 16px 12px", borderBottom: "1px solid " + T.border, textAlign: "center" }}><Logo T={T} width={180} /></div>
      <div style={{ flex: 1, padding: "8px 0" }}>
        {[["profile", "\ud83d\udc64", "Profile"], ["settings", "\u2699\ufe0f", "Settings"], ["contact", "\ud83d\udce7", "Contact Us"], ["about", "\u2139\ufe0f", "About"], ["privacy", "\ud83d\udd12", "Privacy & Disclaimer"], ["faq", "\u2753", "FAQs"]].map(([id, ic, lb]) => (
          <button key={id} onClick={() => { onNav(id); onClose() }} style={{ width: "100%", display: "flex", alignItems: "center", gap: 14, padding: "15px 20px", background: "transparent", border: "none", cursor: "pointer", fontSize: 16, color: T.t1, fontWeight: 600, textAlign: "left" }}><span style={{ fontSize: 22 }}>{ic}</span>{lb}</button>
        ))}
      </div>
      <div style={{ padding: "12px 20px", borderTop: "1px solid " + T.border, fontSize: 10, color: T.t3, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <span>{APP_NAME_VERSION} ({APP_UPDATED})</span>
        <a href={siteLink("drawer")} target="_blank" rel="noopener noreferrer" style={{ color: T.t3, textDecoration: "none", whiteSpace: "nowrap" }}
          onMouseEnter={e => e.currentTarget.style.color = T.accent} onMouseLeave={e => e.currentTarget.style.color = T.t3}>{SITE_LABEL}</a>
      </div>
    </div></>;
}

// ━━━ TPN Page ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function printTPN(ip, res) {
  const rv = v => Math.round(v * 10) / 10;
  const fv = (v, d = 1) => rv(v).toFixed(d);
  const blank = (n = 10) => "_".repeat(n);
  const isPerDay = res.isPerDay;
  const col2Lbl = isPerDay ? `Per ${res.overfill} mL` : "Per 50 mL";

  // Hospital name from user profile
  let hospitalName = "LHMC & Associated Hospitals";
  try {
    const profile = JSON.parse(localStorage.getItem("user_profile") || "{}");
    if (profile.hospital) hospitalName = profile.hospital;
  } catch(e) {}

  // Date formatting: yyyy-mm-dd → dd-mm-yyyy
  const formatDate = (d) => {
    if (!d) return blank(12);
    const parts = d.split("-");
    if (parts.length === 3) return `${parts[2]}-${parts[1]}-${parts[0]}`;
    return d;
  };

  // Syringe 1 – non-zero items only
  const lipidItem  = res.s1.items.find(i => i.l.includes("Lipid"));
  const mviItem    = res.s1.items.find(i => i.l === "MVI");
  const celcelItem = res.s1.items.find(i => i.l === "Celcel");

  const s1Line = [
    lipidItem  && rv(lipidItem.v)  > 0 ? `Inj. 20% Lipid <b>${fv(lipidItem.v)} mL</b>`  : null,
    mviItem    && rv(mviItem.v)    > 0 ? `MVI <b>${fv(mviItem.v)} mL</b>`                : null,
    celcelItem && rv(celcelItem.v) > 0 ? `Celcel <b>${fv(celcelItem.v)} mL</b>`          : null,
  ].filter(Boolean).join(" + ");

  const col2Val = (item) => {
    if (isPerDay) return item.adj != null ? fv(item.adj) : "&mdash;";
    return item.p50 != null ? fv(item.p50) : "&mdash;";
  };

  // Rename labels for print + filter zeros
  const fixLabel = (l) => {
    if (l === "KPO\u2084") return "Potassium PO\u2084";
    return l;
  };
  const syrTableRows = (items) => items
    .filter(item => rv(item.v) > 0)
    .map(item =>
      `<tr><td>${fixLabel(item.l)}</td><td class="rc">${fv(item.v)}</td><td class="rc">${col2Val(item)}</td></tr>`
    ).join("");

  // Syringe numbering for separate infusions
  let nextSyr = res.s3 ? 4 : 3;
  const caSyrNum  = rv(res.sep.ca) > 0 ? nextSyr++ : null;
  const ppSyrNum  = rv(res.sep.pp) > 0 ? nextSyr++ : null;

  // Na / K breakdown
  const naTotal  = rv(res.mon.naIVM) > 0 ? rv(res.mon.naIVM) : 0;
  const naTPN    = rv(ip.sodium - naTotal) > 0 ? rv(ip.sodium - naTotal) : 0;
  const kPPval   = rv(res.mon.kPP) > 0 ? rv(res.mon.kPP) : 0;
  const kIVM     = rv(ip.potassium - kPPval) > 0 ? rv(ip.potassium - kPPval) : 0;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>TPN Order – B/o ${ip.babyOf || ""}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: Arial, sans-serif; font-size: 10.5pt; color: #000; padding: 10mm 12mm; }
  h1  { font-size: 14pt; font-weight: bold; text-align: center; margin-bottom: 2px; letter-spacing: .3px; }
  h2  { font-size: 11pt; font-weight: bold; text-align: center; margin-bottom: 8px; letter-spacing: .5px; }
  h3  { font-size: 10.5pt; margin-bottom: 4px; }
  /* Top header strip */
  .hdr { display: flex; border: 1.5px solid #000; margin-bottom: 8px; }
  .hdr-cell { flex: 1; padding: 5px 8px; border-right: 1px solid #000; }
  .hdr-cell:last-child { border-right: none; }
  /* Two-column body */
  .body-wrap { display: flex; gap: 10px; align-items: flex-start; }
  .col-main { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; }
  .col-side { width: 210px; flex-shrink: 0; }
  /* Respiratory support box */
  .resp-box { border: 1.5px solid #000; padding: 7px 9px; margin-bottom: 6px; }
  /* Summary (side) table */
  table.sum { width: 100%; border-collapse: collapse; border: 1.5px solid #000; font-size: 9.5pt; }
  table.sum td { border: 1px solid #aaa; padding: 3px 6px; vertical-align: top; }
  table.sum td.sl { background: #f0f0f0; font-weight: bold; width: 56%; white-space: nowrap; }
  table.sum td.sv { text-align: right; }
  table.sum tr.sec td { background: #e0e0e0; font-weight: bold; font-size: 9pt; padding: 2px 6px; }
  table.sum .sub { font-size: 8.5pt; color: #444; font-weight: normal; padding-left: 4px; }
  table.sum .unit { font-size: 8pt; font-weight: normal; color: #555; }
  /* Syringe inner table */
  table.syr { width: 100%; border-collapse: collapse; margin: 4px 0 8px; }
  table.syr th { background: #e8e8e8; border: 1px solid #000; padding: 3px 6px; font-size: 9.5pt; }
  table.syr td { border: 1px solid #999; padding: 3px 6px; font-size: 9.5pt; }
  table.syr tr.total td { font-weight: bold; border-top: 1.5px solid #000; background: #f5f5f5; }
  .rc { text-align: right; }
  /* Clinical big box */
  .clinical { border: 1.5px solid #000; padding: 7px 9px; margin-bottom: 6px; }
  .sub-lbl { font-weight: bold; margin-top: 7px; margin-bottom: 3px; font-size: 10pt; }
  .sub-lbl:first-child { margin-top: 0; }
  /* Meds */
  /* Sign – centered at bottom of column */
  .sign { margin-top: auto; padding-top: 24px; text-align: center; font-weight: bold; font-size: 11pt; }
  .sign span { display: inline-block; border-bottom: 1.5px solid #000; min-width: 200px; padding-bottom: 2px; }
  @media print { body { padding: 7mm 9mm; } @page { size: A4; margin: 7mm; } }
</style>
</head>
<body>
<h1>${hospitalName}</h1>
<h2>Neonatal Intensive Care Unit</h2>
<h2 style="font-size:12pt;margin-top:-4px;margin-bottom:8px;">Treatment Chart</h2>

<div class="hdr">
  <div class="hdr-cell"><b>Name:</b> B/o ${ip.babyOf ? ip.babyOf : blank(18)}</div>
  <div class="hdr-cell"><b>Patient ID:</b> ${ip.patientId || blank(14)}</div>
  <div class="hdr-cell"><b>Date:</b> ${formatDate(ip.date)}</div>
</div>

<div class="body-wrap">

  <!-- LEFT: Clinical orders -->
  <div class="col-main">
    <div class="resp-box">
      <div class="sub-lbl" style="margin-top:0;">Respiratory Support:</div>
    </div>

    <div class="clinical">
      <div class="sub-lbl" style="margin-top:0;">Feeds:</div>
      <div style="margin-bottom:4px;font-size:9.5pt;white-space:nowrap;">
        ${blank(3)} feeds &nbsp;(EBM/PDHM)&nbsp; ${blank(3)} mL &nbsp; every ${blank(3)} hourly &nbsp; for ${blank(3)} feeds
      </div>

      <div class="sub-lbl" style="margin-top:14px;">Parenteral Nutrition:</div>

      ${rv(res.s1.total) > 0 ? `<div style="margin-bottom:6px;">
        <b>Syringe 1</b><br>
        ${s1Line || "—"} &nbsp;@ <b>${fv(res.s1.rate, 2)} mL/hr</b>
      </div>` : ""}

      <table class="syr">
        <tr>
          <th style="text-align:left;">Syringe 2</th>
          <th class="rc">Volume</th>
          <th class="rc">${col2Lbl}</th>
        </tr>
        ${syrTableRows(res.s2.items)}
        <tr class="total">
          <td>Total</td>
          <td class="rc">${fv(res.s2.total)} mL</td>
          <td class="rc">@ ${fv(res.s2.rate, 2)} mL/hr</td>
        </tr>
      </table>

      ${res.s3 ? `
      <table class="syr">
        <tr>
          <th style="text-align:left;">Syringe 3</th>
          <th class="rc">Volume</th>
          <th class="rc">${col2Lbl}</th>
        </tr>
        ${syrTableRows(res.s3.items)}
        <tr class="total">
          <td>Total</td>
          <td class="rc">${fv(res.s3.total)} mL</td>
          <td class="rc">@ ${fv(res.s3.rate, 2)} mL/hr</td>
        </tr>
      </table>` : ""}

      ${caSyrNum != null ? `
      <div style="margin-bottom:16px;">
        <b>Syringe ${caSyrNum}: (Calcium)</b><br>
        Inj. 10% Calcium Gluconate &nbsp; <b>${fv(res.sep.ca, 2)} mL</b>
      </div>` : ""}

      ${ppSyrNum != null ? `
      <div style="margin-bottom:16px;">
        <b>Syringe ${ppSyrNum}: (Phosphorus)</b><br>
        Inj. Potassium Phosphate (Potphos) &nbsp; <b>${fv(res.sep.pp, 2)} mL</b>
      </div>` : ""}
    </div>

    <div class="sub-lbl" style="margin-top:4px;">Medications:</div>
    <div style="margin-top:4px;">1.</div>
  </div>

  <!-- RIGHT: Summary table -->
  <div class="col-side">
    <table class="sum">
      <tr class="sec"><td colspan="2">Patient Parameters</td></tr>
      <tr><td class="sl">PNA</td><td class="sv">Day ${blank(4)}</td></tr>
      <tr><td class="sl">PMA</td><td class="sv">${blank(4)} wks</td></tr>
      <tr><td class="sl">Weight <span class="unit">g</span></td><td class="sv"><b>${ip.weightG}</b></td></tr>

      <tr class="sec"><td colspan="2">Fluids</td></tr>
      <tr><td class="sl">TFR <span class="unit">mL/kg</span></td><td class="sv"><b>${ip.tfr}</b></td></tr>
      <tr><td class="sl">Total Vol <span class="unit">mL</span></td><td class="sv"><b>${fv(res.mon.tfv)}</b></td></tr>
      <tr><td class="sl">Feeds <span class="unit">mL/kg</span></td><td class="sv"><b>${ip.feeds}</b></td></tr>
      <tr><td class="sl">IVM <span class="unit">mL</span></td><td class="sv"><b>${ip.ivm}</b></td></tr>
      <tr><td class="sl">TPN fluid <span class="unit">mL</span></td><td class="sv"><b>${fv(res.mon.tpn)}</b></td></tr>

      <tr class="sec"><td colspan="2">Nutrition</td></tr>
      <tr><td class="sl">AA <span class="unit">g/kg/d</span></td><td class="sv"><b>${ip.aminoAcid}</b></td></tr>
      <tr><td class="sl">Lipid <span class="unit">g/kg/d</span></td><td class="sv"><b>${ip.lipid}</b></td></tr>
      <tr><td class="sl">GIR <span class="unit">mg/kg/min</span></td><td class="sv"><b>${ip.gir}</b></td></tr>
      <tr><td class="sl">Glucose <span class="unit">g</span></td><td class="sv"><b>${fv(res.mon.tpnG)}</b></td></tr>

      <tr class="sec"><td colspan="2">Electrolytes</td></tr>
      <tr>
        <td class="sl">
          Na <span class="unit">mEq/kg/d</span><br>
          <span class="sub">via TPN: ${naTPN}</span><br>
          <span class="sub">via IVM: ${naTotal > 0 ? naTotal : "—"}</span>
        </td>
        <td class="sv"><b>${ip.sodium}</b></td>
      </tr>
      <tr>
        <td class="sl">
          K <span class="unit">mEq/kg/d</span><br>
          <span class="sub">via KCl/IVM: ${kIVM > 0 ? kIVM : "—"}</span><br>
          <span class="sub">via PotPhos: ${kPPval > 0 ? kPPval : "—"}</span>
        </td>
        <td class="sv"><b>${ip.potassium}</b></td>
      </tr>

      ${rv(ip.magnesium) > 0 ? `
      <tr><td class="sl">Mg <span class="unit">mEq/kg/d</span></td><td class="sv"><b>${ip.magnesium}</b></td></tr>` : ""}
      <tr><td class="sl">Ca <span class="unit">mg/kg/d</span></td><td class="sv"><b>${ip.calcium}</b></td></tr>
      <tr><td class="sl">PO₄ <span class="unit">mg/kg/d</span></td><td class="sv"><b>${ip.po4}</b></td></tr>

      <tr class="sec"><td colspan="2">Calculated Values</td></tr>
      <tr><td class="sl">Dextrose <span class="unit">%</span></td><td class="sv"><b>${fv(res.mon.dex, 1)}%</b></td></tr>
      <tr><td class="sl">Osmolarity <span class="unit">mOsm</span></td><td class="sv"><b>${Math.round(res.mon.osm)}</b></td></tr>
    </table>
  </div>

</div>

<script>window.onload = function() { window.print(); };</script>
</body>
</html>`;

  const w = window.open("", "_blank", "width=860,height=1100");
  if (!w) { alert("Pop-up blocked. Please allow pop-ups for this site."); return; }
  w.document.write(html);
  w.document.close();
}

function TPNPage({ T, defaults }) {
  const [ip, setIp] = useState({ ...defaults, babyOf: "", patientId: "", date: todayStr() });
  const [show, setShow] = useState(false);
  const [sec, setSec] = useState({ pat: true, nut: true, elec: true, ivm: false, conf: false, add: false });
  const [oi, soi] = useState(null);
  const rRef = useRef(null);
  const s = useCallback(k => v => setIp(p => ({ ...p, [k]: v })), []);
  const t = k => setSec(p => ({ ...p, [k]: !p[k] }));
  const res = useMemo(() => { try { return calculateTPN(ip) } catch (e) { return { errors: ["Unexpected: " + e.message] } } }, [ip]);
  const hasErr = res?.errors?.length > 0;
  const go = () => { setShow(true); if (!hasErr) setTimeout(() => rRef.current?.scrollIntoView({ behavior: "smooth" }), 100) };
  useEffect(() => { if (!oi) return; const h = () => soi(null); const tm = setTimeout(() => document.addEventListener("mousedown", h), 10); return () => { clearTimeout(tm); document.removeEventListener("mousedown", h) } }, [oi]);

  // Baby history
  const [babyHist, setBabyHist] = useState([]);
  const [nameQ, setNameQ] = useState(""); const [idQ, setIdQ] = useState("");
  const [nameFocus, setNameFocus] = useState(false); const [idFocus, setIdFocus] = useState(false);
  const [loadedBaby, setLoadedBaby] = useState(null);

  useEffect(() => { (async () => { try { const raw = await storeGet("baby_history"); if (raw) { const all = JSON.parse(raw); const cutoff = Date.now() - 30 * 86400000; setBabyHist(all.filter(b => new Date(b.ts).getTime() > cutoff)) } } catch { } })() }, []);

  const nameSugg = nameFocus && ip.babyOf.length > 0 ? babyHist.filter(b => b.babyOf && b.babyOf.toLowerCase().includes(ip.babyOf.toLowerCase())).reduce((acc, b) => { if (!acc.find(x => x.babyOf === b.babyOf && x.patientId === b.patientId)) acc.push(b); return acc }, []).slice(0, 5) : [];
  const idSugg = idFocus && ip.patientId.length > 0 ? babyHist.filter(b => b.patientId && b.patientId.startsWith(ip.patientId)).reduce((acc, b) => { if (!acc.find(x => x.patientId === b.patientId)) acc.push(b); return acc }, []).slice(0, 5) : [];

  const loadBaby = (entry) => {
    const { babyOf, patientId, inputs } = entry;
    setIp(prev => ({ ...inputs, babyOf, patientId, date: todayStr() }));
    setLoadedBaby(entry);
    setNameFocus(false); setIdFocus(false); setShow(false);
  };

  const saveTPN = async () => {
    const entry = { babyOf: ip.babyOf, patientId: ip.patientId, inputs: { ...ip }, results: res, ts: new Date().toISOString() };
    const updated = [entry, ...babyHist.filter(b => !(b.babyOf === ip.babyOf && b.patientId === ip.patientId && b.inputs?.date === ip.date))].slice(0, 200);
    try { await storeSet("baby_history", JSON.stringify(updated)); setBabyHist(updated); alert("Saved!") } catch { alert("Save failed") }
  };

  const isPerDay = res && !hasErr && res.isPerDay;
  const col2Lbl = isPerDay ? "Adj. Vol" : "Per 50 mL";
  const fortLabel = (defaults.hmfProtPerG || 0) < 0.2 ? "PTF" : "HMF";
  const ddStyle = { position: "absolute", top: "100%", left: 0, right: 0, zIndex: 50, background: T.card, border: "1.5px solid " + T.accent + "44", borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,.15)", maxHeight: 180, overflowY: "auto", marginTop: 2 };
  const ddItem = { padding: "8px 10px", cursor: "pointer", borderBottom: "1px solid " + T.border + "44" };

  return <div>
    <div style={{ background: T.card, borderRadius: 12, border: "1px solid " + T.border, marginBottom: 8, padding: "10px 12px", boxShadow: T.shadow }}>
      {loadedBaby && <div style={{ marginBottom: 8, padding: "6px 10px", background: T.accentDim, borderRadius: 8, border: "1px solid " + T.accent + "22", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 11, color: T.accentText, fontWeight: 600 }}>Loaded from {new Date(loadedBaby.ts).toLocaleDateString()}</span>
        <button onClick={() => { setIp({ ...defaults, babyOf: "", patientId: "", date: todayStr() }); setLoadedBaby(null); setShow(false) }} style={{ fontSize: 10, color: T.t3, background: "transparent", border: "none", cursor: "pointer", fontWeight: 600 }}>Clear</button>
      </div>}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
        <div style={{ position: "relative" }}><label style={{ fontSize: 10, color: T.t3, fontWeight: 600, textTransform: "uppercase", display: "block", marginBottom: 4 }}>Baby of (Mother)</label><input value={ip.babyOf} onChange={e => { s("babyOf")(e.target.value); setLoadedBaby(null) }} onFocus={() => setNameFocus(true)} onBlur={() => setTimeout(() => setNameFocus(false), 150)} placeholder="Mother's name" style={{ width: "100%", height: 38, padding: "0 8px", fontSize: 12, fontWeight: 600, background: T.inp, border: "1.5px solid " + T.inpBorder, borderRadius: 8, color: T.t1, outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
          {nameSugg.length > 0 && <div style={ddStyle}>{nameSugg.map((b, i) => <div key={i} onMouseDown={() => loadBaby(b)} style={ddItem} onMouseEnter={e => e.currentTarget.style.background = T.accentDim} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <div style={{ fontSize: 12, fontWeight: 600, color: T.t1 }}>{b.babyOf}</div>
            <div style={{ fontSize: 10, color: T.t3 }}>{b.patientId ? "ID: " + b.patientId + " | " : ""}{new Date(b.ts).toLocaleDateString()}</div>
          </div>)}</div>}
        </div>
        <div style={{ position: "relative" }}><label style={{ fontSize: 10, color: T.t3, fontWeight: 600, textTransform: "uppercase", display: "block", marginBottom: 4 }}>Patient ID</label><input value={ip.patientId} onChange={e => { s("patientId")(e.target.value.replace(/\D/g, "")); setLoadedBaby(null) }} onFocus={() => setIdFocus(true)} onBlur={() => setTimeout(() => setIdFocus(false), 150)} placeholder="Numeric" inputMode="numeric" style={{ width: "100%", height: 38, padding: "0 6px", fontSize: 13, fontWeight: 600, background: T.inp, border: "1.5px solid " + T.inpBorder, borderRadius: 8, color: T.t1, outline: "none", fontFamily: "'JetBrains Mono',monospace", boxSizing: "border-box" }} />
          {idSugg.length > 0 && <div style={ddStyle}>{idSugg.map((b, i) => <div key={i} onMouseDown={() => loadBaby(b)} style={ddItem} onMouseEnter={e => e.currentTarget.style.background = T.accentDim} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <div style={{ fontSize: 12, fontWeight: 600, color: T.t1 }}>{b.patientId}</div>
            <div style={{ fontSize: 10, color: T.t3 }}>{b.babyOf ? b.babyOf + " | " : ""}{new Date(b.ts).toLocaleDateString()}</div>
          </div>)}</div>}
        </div>
        <div><label style={{ fontSize: 10, color: T.t3, fontWeight: 600, textTransform: "uppercase", display: "block", marginBottom: 4 }}>Date</label><input type="date" value={ip.date} onChange={e => s("date")(e.target.value)} style={{ width: "100%", height: 38, padding: "0 4px", fontSize: 11, fontWeight: 600, background: T.inp, border: "1.5px solid " + T.inpBorder, borderRadius: 8, color: T.t1, outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} /></div>
      </div>
    </div>

    <Sec title="Patient & Fluids" open={sec.pat} onToggle={() => t("pat")} T={T}>
      <Row><NI label="Weight" unit="g" value={ip.weightG} onChange={s("weightG")} step={10} min={0} max={9999} T={T} info="weight" oi={oi} soi={soi} /><NI label="TFR" unit="mL/kg/d" value={ip.tfr} onChange={s("tfr")} step={5} T={T} info="tfr" oi={oi} soi={soi} /></Row>
      <Row><NI label="Feeds" unit="mL/kg/d" value={ip.feeds} onChange={s("feeds")} step={5} T={T} info="feeds" oi={oi} soi={soi} /><NI label="IV medications" unit="mL" value={ip.ivm} onChange={s("ivm")} step={1} T={T} info="ivm" oi={oi} soi={soi} /></Row>
      <Row><Pills label="Feed type" value={ip.feedType} options={["NPO", "EBM/PDHM", "Formula"]} onChange={s("feedType")} T={T} info="feedType" oi={oi} soi={soi} />{ip.feedType !== "NPO" && ip.feedType !== "Formula" ? <Pills label={fortLabel + " strength"} value={ip.prenanStrength} options={["None", "Quarter", "Half", "Full"]} onChange={s("prenanStrength")} T={T} info="hmf" oi={oi} soi={soi} /> : <div style={{ flex: "1 1 0" }} />}</Row>
    </Sec>

    <Sec title="Nutrition Targets" open={sec.nut} onToggle={() => t("nut")} T={T}>
      <Row><NI label="Amino acids (A)" unit="g/kg/d" value={ip.aminoAcid} onChange={s("aminoAcid")} step={.25} T={T} info="aminoAcid" oi={oi} soi={soi} /><NI label="Lipids (L)" unit="g/kg/d" value={ip.lipid} onChange={s("lipid")} step={.25} T={T} info="lipid" oi={oi} soi={soi} /><NI label="GIR (G)" unit="mg/kg/min" value={ip.gir} onChange={s("gir")} step={.5} T={T} info="gir" oi={oi} soi={soi} /></Row>
    </Sec>

    <Sec title="Electrolytes" open={sec.elec} onToggle={() => t("elec")} T={T}>
      <Row><NI label="Na" unit="mEq/kg/d" value={ip.sodium} onChange={s("sodium")} step={.5} T={T} info="na" oi={oi} soi={soi} /><NI label="K" unit="mEq/kg/d" value={ip.potassium} onChange={s("potassium")} step={.5} T={T} info="k" oi={oi} soi={soi} /><NI label="Ca" unit="mg/kg/d" value={ip.calcium} onChange={s("calcium")} step={5} T={T} info="ca" oi={oi} soi={soi} /></Row>
      <Row><NI label="PO4" unit="mg/kg/d" value={ip.po4} onChange={s("po4")} step={5} T={T} info="po4" oi={oi} soi={soi} /><NI label="Mg" unit="mEq/kg/d" value={ip.magnesium} onChange={s("magnesium")} step={.5} T={T} info="mg" oi={oi} soi={soi} /><div style={{ flex: "1 1 0" }} /></Row>
    </Sec>

    <Sec title="IV Medications Breakdown" open={sec.ivm} onToggle={() => t("ivm")} T={T}>
      <Row><NI label="N/5" unit="mL" value={ip.ivmN5} onChange={s("ivmN5")} step={1} T={T} info="ivmBreak" oi={oi} soi={soi} /><NI label="N/2" unit="mL" value={ip.ivmN2} onChange={s("ivmN2")} step={1} T={T} /><NI label="NS" unit="mL" value={ip.ivmNS} onChange={s("ivmNS")} step={1} T={T} /><NI label="5% Dex" unit="mL" value={ip.ivmDex5} onChange={s("ivmDex5")} step={1} T={T} /><NI label="10% Dex" unit="mL" value={ip.ivmDex10} onChange={s("ivmDex10")} step={1} T={T} /></Row>
    </Sec>

    <Sec title="Configuration" open={sec.conf} onToggle={() => t("conf")} T={T}>
      <Row><Pills label="AA source" value={ip.aaSource} options={["Aminoven", "Pentamin"]} onChange={s("aaSource")} T={T} info="aaSource" oi={oi} soi={soi} /><Pills label="Na source" value={ip.naSource} options={[{ label: "3% NaCl", value: "3% NaCl" }, { label: "Conc. RL", value: "CRL" }]} onChange={s("naSource")} T={T} info="naSource" oi={oi} soi={soi} /></Row>
      <Row><Pills label="Low dextrose" value={ip.use5Dex ? "5%" : "10%"} options={[{ label: "5%", value: "5%" }, { label: "10%", value: "10%" }]} onChange={v => s("use5Dex")(v === "5%")} T={T} info="dex" oi={oi} soi={soi} /><Pills label="High dextrose" value={ip.use25Dex ? "25%" : "50%"} options={[{ label: "25%", value: "25%" }, { label: "50%", value: "50%" }]} onChange={v => s("use25Dex")(v === "25%")} T={T} /><Tog label="Ca in Syringe 2" value={ip.caViaTPN} onChange={s("caViaTPN")} T={T} info="caInTPN" oi={oi} soi={soi} /><Tog label="PO4 in Syringe 2" value={ip.po4ViaTPN} onChange={s("po4ViaTPN")} T={T} info="po4InTPN" oi={oi} soi={soi} /></Row>
      <Row><Pills label="Syringes" value={ip.syringeCount} options={[{ label: "2 Syringes", value: 2 }, { label: "3 Syringes", value: 3 }]} onChange={s("syringeCount")} T={T} info="syringe" oi={oi} soi={soi} /><div style={{ flex: "1 1 0" }} /></Row>
    </Sec>

    <Sec title="Additives & Overfill" open={sec.add} onToggle={() => t("add")} T={T}>
      <Row><NI label="Celcel" unit="mL/kg/d" value={ip.celcel} onChange={s("celcel")} step={.5} max={1.5} T={T} info="celcel" oi={oi} soi={soi} /><NI label="MVI" unit="mL/kg/d" value={ip.mvi} onChange={s("mvi")} step={.5} max={1.5} T={T} info="mviHelp" oi={oi} soi={soi} /><NI label="Overfill" unit="x" value={ip.overfill} onChange={s("overfill")} step={.05} min={1} max={1.5} T={T} info="overfill" oi={oi} soi={soi} /></Row>
    </Sec>

    <div style={{ display: "flex", gap: 8, marginTop: 4, marginBottom: 12 }}>
      <button onClick={go} style={{ flex: 1, padding: 14, fontSize: 15, fontWeight: 700, background: T.btnGrad, color: "#fff", border: "none", borderRadius: 12, cursor: "pointer", boxShadow: "0 4px 16px " + T.accent + "33" }}>Calculate TPN</button>
      <button onClick={() => { setIp({ ...defaults, babyOf: ip.babyOf, patientId: ip.patientId, date: ip.date }); setShow(false); setLoadedBaby(null) }} style={{ padding: "14px 16px", fontSize: 12, fontWeight: 600, background: T.card, color: T.t3, border: "1px solid " + T.border, borderRadius: 12, cursor: "pointer" }}>Reset</button>
    </div>

    {show && hasErr && <div style={{ background: T.redBg, borderRadius: 12, padding: 16, marginBottom: 12, border: "2px solid " + T.redBorder }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}><div style={{ width: 28, height: 28, borderRadius: 14, background: T.redBright, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 800, flexShrink: 0 }}>!</div><div style={{ fontSize: 15, fontWeight: 700, color: T.redBright }}>Cannot Calculate TPN</div></div>
      {res.errors.map((e, i) => <div key={i} style={{ fontSize: 12, color: T.redBright, marginBottom: 8, paddingLeft: 14, position: "relative", lineHeight: 1.6, fontWeight: 500 }}><span style={{ position: "absolute", left: 0, fontWeight: 700 }}>{i + 1}.</span> {e}</div>)}
      <div style={{ fontSize: 11, color: T.t3, marginTop: 10, borderTop: "1px solid " + T.redBorder, paddingTop: 8 }}>Fix the issues above and recalculate.</div>
    </div>}

    {show && !hasErr && res && <div ref={rRef} style={{ animation: "fadeIn .35s ease" }}>
      {res.warnings.length > 0 && <div style={{ background: T.amberDim, borderRadius: 10, padding: "10px 12px", marginBottom: 8, border: "1px solid " + T.amber + "30" }}>{res.warnings.map((w, i) => <div key={i} style={{ fontSize: 11, color: T.amber, marginBottom: 2, fontWeight: 600 }}>! {w}</div>)}</div>}

      {(ip.babyOf || ip.patientId || ip.date) && <div style={{ background: T.card, borderRadius: 10, padding: "8px 12px", marginBottom: 8, border: "1px solid " + T.border, display: "flex", justifyContent: "space-between", fontSize: 12, flexWrap: "wrap", gap: 4 }}>
        {ip.babyOf && <span style={{ color: T.t1, fontWeight: 600 }}>Baby of {ip.babyOf}</span>}
        {ip.patientId && <span style={{ color: T.t3 }}>ID: {ip.patientId}</span>}
        {ip.date && <span style={{ color: T.t3 }}>{ip.date}</span>}
      </div>}

      <SyrCard title="Syringe 1 - Lipid" tag="S1" color={T.green} T={T} total={res.s1.total} rate={res.s1.rate} hasCol2={res.s1.show50 || isPerDay} col2Label={col2Lbl} alignWith3Col={!res.s1.show50 && !isPerDay} items={res.s1.items} />
      <SyrCard title={ip.syringeCount === 3 ? "Syringe 2 - Protein/Electrolytes" : "Syringe 2 - Dextrose/Protein"} tag="S2" color={T.accent} T={T} total={res.s2.total} rate={res.s2.rate} hasCol2={true} col2Label={col2Lbl} items={res.s2.items} />
      {res.s3 && <SyrCard title="Syringe 3 - Dextrose" tag="S3" color={T.purple} T={T} total={res.s3.total} rate={res.s3.rate} hasCol2={true} col2Label={col2Lbl} items={res.s3.items} />}

      {(r1(res.sep.pp) > 0 || r1(res.sep.ca) > 0) && <div style={{ background: T.card, borderRadius: 10, padding: "10px 12px", marginBottom: 8, border: "1px solid " + T.border, boxShadow: T.shadow }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: T.purple, marginBottom: 6 }}>Separate Infusions</div>
        {r1(res.sep.pp) > 0 && <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "3px 0" }}><span style={{ color: T.t2 }}>PotPhos</span><div><span style={{ fontWeight: 600, fontFamily: "'JetBrains Mono',monospace" }}>{fV(res.sep.pp)}</span><span style={{ fontSize: 10, color: T.t3, marginLeft: 2 }}>mL/d</span></div></div>}
        {r1(res.sep.ca) > 0 && <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "3px 0" }}><span style={{ color: T.t2 }}>10% Ca Gluconate (separate)</span><div><span style={{ fontWeight: 600, fontFamily: "'JetBrains Mono',monospace" }}>{fV(res.sep.ca)}</span><span style={{ fontSize: 10, color: T.t3, marginLeft: 2 }}>mL/d</span></div></div>}
      </div>}

      <div style={{ background: T.card, borderRadius: 12, padding: 10, marginBottom: 8, border: "1px solid " + T.border, boxShadow: T.shadow }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: T.accentText, marginBottom: 8, paddingLeft: 2 }}>Monitoring</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          <Metric label="Dextrose" val={r1(res.mon.dex).toFixed(1)} unit="%" color={T.accent} warn={res.mon.dex > 12.5 ? "mid" : undefined} T={T} />
          <Metric label="CNR" val={r1(res.mon.cnr).toFixed(0)} unit="" color={T.green} T={T} />
          <Metric label="Osmolarity" val={Math.round(res.mon.osm)} unit="mOsm" color={T.accent} warn={res.mon.osm > 900 ? "mid" : undefined} T={T} />
          <Metric label="Calories" val={r1(res.mon.cal).toFixed(1)} unit="kcal/kg" color={T.amber} T={T} />
          <Metric label="Protein" val={r1(res.mon.prot).toFixed(1)} unit="g/kg" color={T.purple} T={T} />
          <Metric label="TPN glucose" val={r1(res.mon.tpnG).toFixed(1)} unit="g" color={T.green} T={T} />
        </div>
      </div>

      <div style={{ background: T.card, borderRadius: 12, padding: "10px 12px", marginBottom: 8, border: "1px solid " + T.border, boxShadow: T.shadow }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: T.t3, marginBottom: 6 }}>Fluid Summary</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
          {[["Total fluid vol", r1(res.mon.tfv), "mL"], ["Feeds", r1(res.mon.feeds), "mL"], ["IV fluid rate", r1(res.mon.ivfKg), "mL/kg"], ["TPN fluid", r1(res.mon.tpn), "mL"], ["Glucose fluid", r1(res.mon.gFluid), "mL"], ["Na in IVM", r1(res.mon.naIVM), "mEq/kg"], ["Glucose in IVM", r1(res.mon.gIVM), "g"], ["K from PotPhos", r1(res.mon.kPP), "mEq/kg"]].map(([l, v, u], i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "4px 0", borderBottom: "1px solid " + T.border + "44" }}>
              <span style={{ fontSize: 11, color: T.t3 }}>{l}</span>
              <span style={{ fontFamily: "'JetBrains Mono',monospace" }}><span style={{ fontSize: 12, fontWeight: 600, color: T.t2 }}>{typeof v === "number" ? v.toFixed(1) : v}</span><span style={{ fontSize: 9, color: T.t3, marginLeft: 2 }}>{u}</span></span>
            </div>))}
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button onClick={saveTPN} style={{ flex: 1, padding: 12, fontSize: 13, fontWeight: 700, background: T.card, color: T.accentText, border: "1.5px solid " + T.accent + "33", borderRadius: 10, cursor: "pointer" }}>💾 Save</button>
        <button onClick={() => printTPN(ip, res)} style={{ flex: 1, padding: 12, fontSize: 13, fontWeight: 700, background: T.card, color: T.t2, border: "1.5px solid " + T.border, borderRadius: 10, cursor: "pointer" }}>🖨️ Print</button>
      </div>
    </div>}
  </div>;
}

// ━━━ GIR Page ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function GIRPage({ T }) {
  const [wt, setWt] = useState(1000);
  const [fluidPerKg, setFluidPerKg] = useState(60);
  const [targetGir, setTargetGir] = useState(6);
  const [dexCombo, setDexCombo] = useState("10+50");
  const [oi, soi] = useState(null);

  useEffect(() => { if (!oi) return; const h = () => soi(null); const tm = setTimeout(() => document.addEventListener("mousedown", h), 10); return () => { clearTimeout(tm); document.removeEventListener("mousedown", h) } }, [oi]);

  const combos = { "10only": [10, 10], "5+25": [5, 25], "5+50": [5, 50], "10+25": [10, 25], "10+50": [10, 50] };
  const [dLow, dHigh] = combos[dexCombo];
  const isSingle = dLow === dHigh;
  const wtKg = wt / 1000;
  const vol = fluidPerKg * wtKg;
  const valid = wtKg > 0 && vol > 0;

  // Single dex: GIR is fixed
  const singleGir = valid ? (dLow * vol) / (wtKg * 144) : 0;

  // Dual dex: solve volumes for target GIR
  const reqDex = valid ? (targetGir * wtKg * 144) / vol : 0;
  const vHigh = !isSingle && dHigh !== dLow ? (reqDex - dLow) * vol / (dHigh - dLow) : 0;
  const vLow = vol - vHigh;
  const isExact = !isSingle && vLow >= -0.05 && vHigh >= -0.05;
  const girMin = valid && !isSingle ? (dLow * vol) / (wtKg * 144) : 0;
  const girMax = valid && !isSingle ? (dHigh * vol) / (wtKg * 144) : 0;

  // Clamped for closest-achievable
  const cVHigh = Math.max(0, Math.min(vol, vHigh));
  const cVLow = vol - cVHigh;
  const finalDex = vol > 0 ? (dLow * cVLow + dHigh * cVHigh) / vol : 0;
  const achievedGir = valid ? (finalDex * vol) / (wtKg * 144) : 0;
  const rate = vol / 24;

  // Suggestions when not exact
  const suggestions = valid && !isSingle && !isExact ? Object.entries(combos)
    .filter(([k]) => k !== dexCombo && k !== "10only")
    .map(([k, [lo, hi]]) => {
      const mn = (lo * vol) / (wtKg * 144);
      const mx = (hi * vol) / (wtKg * 144);
      return { key: k, lo, hi, girMin: mn, girMax: mx, canAchieve: targetGir >= mn - 0.05 && targetGir <= mx + 0.05 };
    }).filter(sg => sg.canAchieve) : [];

  // Dex volume card with prominent percentage badge
  const DexVol = ({ pct, mlVal, totalVol, color }) => {
    const p50 = totalVol > 0 ? mlVal * 50 / totalVol : 0;
    return <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: color + "08", borderRadius: 10, border: "1.5px solid " + color + "25" }}>
      <div style={{ width: 48, height: 48, borderRadius: 12, background: color + "14", border: "2px solid " + color + "40", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <span style={{ fontSize: 17, fontWeight: 800, color, fontFamily: "'JetBrains Mono',monospace" }}>{pct}%</span>
      </div>
      <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
        <div style={{ fontSize: 9, color: T.t3, fontWeight: 600 }}>Volume</div>
        <div style={{ fontSize: 9, color: T.t3, fontWeight: 600 }}>Per 50 mL</div>
        <div><span style={{ fontSize: 22, fontWeight: 800, color: T.t1, fontFamily: "'JetBrains Mono',monospace" }}>{fV(mlVal)}</span><span style={{ fontSize: 10, color: T.t3, marginLeft: 2 }}>mL</span></div>
        <div><span style={{ fontSize: 22, fontWeight: 800, color: T.t2, fontFamily: "'JetBrains Mono',monospace" }}>{fV(p50)}</span><span style={{ fontSize: 10, color: T.t3, marginLeft: 2 }}>mL</span></div>
      </div>
    </div>;
  };

  return <div>
    {/* ── Inputs ── */}
    <div style={{ background: T.card, borderRadius: 12, padding: 16, border: "1px solid " + T.border, boxShadow: T.shadow, marginBottom: 8 }}>
      <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 700, color: T.t1 }}>GIR Dextrose Calculator</h3>
      <p style={{ fontSize: 12, color: T.t3, margin: "0 0 14px" }}>Calculate dextrose volumes for a target GIR</p>
      <Row>
        <NI label="Weight" unit="g" value={wt} onChange={setWt} step={10} min={0} T={T} info="weight" oi={oi} soi={soi} />
        <NI label="Fluid" unit="mL/kg/d" value={fluidPerKg} onChange={setFluidPerKg} step={5} min={0} T={T} info="girFluid" oi={oi} soi={soi} />
      </Row>
      {!isSingle && <Row>
        <NI label="Target GIR" unit="mg/kg/min" value={targetGir} onChange={v => setTargetGir(parseFloat(parseFloat(v).toFixed(2)))} step={0.5} min={0} T={T} info="gir" oi={oi} soi={soi} />
        <div style={{ flex: "2 1 0", minWidth: 0, display: "flex", alignItems: "flex-end" }}>
          <div style={{ width: "100%", padding: "8px 12px", background: T.accentDim, borderRadius: 8, border: "1px solid " + T.accent + "22", textAlign: "center" }}>
            <span style={{ fontSize: 9, color: T.t3, fontWeight: 600, display: "block", marginBottom: 2 }}>TARGET</span>
            <span style={{ fontSize: 28, fontWeight: 800, color: T.accentText, fontFamily: "'JetBrains Mono',monospace", letterSpacing: "-0.5px" }}>{Number.isInteger(targetGir) ? targetGir.toFixed(1) : targetGir}</span>
            <span style={{ fontSize: 10, color: T.t3, marginLeft: 4 }}>mg/kg/min</span>
          </div>
        </div>
      </Row>}
      <Row>
        <Pills label="Dextrose" value={dexCombo} options={[
          { label: "10% only", value: "10only" },
          { label: "5+25%", value: "5+25" }, { label: "5+50%", value: "5+50" },
          { label: "10+25%", value: "10+25" }, { label: "10+50%", value: "10+50" },
        ]} onChange={setDexCombo} T={T} info="girDex" oi={oi} soi={soi} />
      </Row>
    </div>

    {valid && <div style={{ animation: "fadeIn .35s ease" }}>

      {/* ── SINGLE DEXTROSE ── */}
      {isSingle && <div style={{ background: T.card, borderRadius: 12, padding: 12, border: "1px solid " + T.accent + "30", boxShadow: T.shadow, marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <div style={{ width: 28, height: 28, borderRadius: 14, background: T.accent + "15", border: "1.5px solid " + T.accent + "40", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, flexShrink: 0, color: T.accentText, fontWeight: 800 }}>{dLow}</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.accentText }}>{dLow}% Dextrose Only</div>
        </div>
        <DexVol pct={dLow} mlVal={vol} totalVol={vol} color={T.accent} />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
          <Metric label="Dextrose %" val={dLow.toFixed(0)} unit="%" color={T.accent} T={T} />
          <Metric label="GIR achieved" val={singleGir.toFixed(2)} unit="mg/kg/min" color={T.green} T={T} />
          <Metric label="Rate" val={rate.toFixed(2)} unit="mL/hr" color={T.purple} T={T} />
        </div>
      </div>}

      {/* ── DUAL DEXTROSE ── */}
      {!isSingle && <div style={{ background: T.card, borderRadius: 12, padding: 12, border: "1px solid " + (isExact ? T.green : T.amber) + "30", boxShadow: T.shadow, marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <div style={{ width: 28, height: 28, borderRadius: 14, background: (isExact ? T.green : T.amber) + "15", border: "1.5px solid " + (isExact ? T.green : T.amber) + "40", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, flexShrink: 0 }}>{isExact ? "\u2713" : "\u2248"}</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: isExact ? T.green : T.amber }}>{isExact ? "Exact Mix Available" : "Closest Achievable Mix"}</div>
        </div>

        {!isExact && <div style={{ background: T.amberDim, borderRadius: 8, padding: "8px 10px", marginBottom: 12, border: "1px solid " + T.amber + "25" }}>
          <div style={{ fontSize: 11, color: T.amber, fontWeight: 600, marginBottom: 2 }}>Target GIR {targetGir} is {targetGir < girMin ? "below" : "above"} the range for {dLow}% + {dHigh}%</div>
          <div style={{ fontSize: 11, color: T.t2 }}>Achievable: <span style={{ fontWeight: 700, fontFamily: "'JetBrains Mono',monospace" }}>{girMin.toFixed(2)}</span> {"\u2013"} <span style={{ fontWeight: 700, fontFamily: "'JetBrains Mono',monospace" }}>{girMax.toFixed(2)}</span> mg/kg/min</div>
        </div>}

        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
          <DexVol pct={dLow} mlVal={isExact ? Math.max(0, vLow) : cVLow} totalVol={vol} color={T.accent} />
          <DexVol pct={dHigh} mlVal={isExact ? Math.max(0, vHigh) : cVHigh} totalVol={vol} color={T.purple} />
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          <Metric label="Final Dex %" val={(isExact ? reqDex : finalDex).toFixed(1)} unit="%" color={T.accent} T={T} />
          <Metric label={isExact ? "GIR" : "Achieved GIR"} val={(isExact ? targetGir : achievedGir).toFixed(2)} unit="mg/kg/min" color={T.green} warn={!isExact ? "mid" : undefined} T={T} />
          <Metric label="Rate" val={rate.toFixed(2)} unit="mL/hr" color={T.purple} T={T} />
        </div>
      </div>}

      {/* ── Suggestions ── */}
      {suggestions.length > 0 && <div style={{ background: T.card, borderRadius: 10, padding: "10px 12px", marginBottom: 8, border: "1px solid " + T.green + "25", boxShadow: T.shadow }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: T.green, marginBottom: 8 }}>Try these combos for GIR {targetGir}</div>
        {suggestions.map(sg => (
          <button key={sg.key} onClick={() => setDexCombo(sg.key)} style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px", marginBottom: 4, background: T.accentDim, border: "1px solid " + T.accent + "20", borderRadius: 8, cursor: "pointer", fontSize: 12 }}>
            <span style={{ fontWeight: 700, color: T.accentText }}>{sg.lo}% + {sg.hi}%</span>
            <span style={{ color: T.t3, fontSize: 11 }}>range {sg.girMin.toFixed(1)} {"\u2013"} {sg.girMax.toFixed(1)}</span>
          </button>
        ))}
      </div>}

      {/* ── Fluid summary ── */}
      <div style={{ background: T.card, borderRadius: 10, padding: "10px 12px", marginBottom: 8, border: "1px solid " + T.border, boxShadow: T.shadow }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: T.t3, marginBottom: 6 }}>Fluid Summary</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
          {[["Weight", fV(wt), "g"], ["Fluid/kg", fV(fluidPerKg), "mL/kg"], ["Total volume", fV(vol), "mL"], ["Rate (24h)", rate.toFixed(2), "mL/hr"]].map(([l, v, u], i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "4px 0", borderBottom: "1px solid " + T.border + "44" }}>
              <span style={{ fontSize: 11, color: T.t3 }}>{l}</span>
              <span style={{ fontFamily: "'JetBrains Mono',monospace" }}><span style={{ fontSize: 12, fontWeight: 600, color: T.t2 }}>{v}</span><span style={{ fontSize: 9, color: T.t3, marginLeft: 2 }}>{u}</span></span>
            </div>))}
        </div>
      </div>
    </div>}
  </div>;
}

// ━━━ Other Pages ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ━━━ Nutrient Database ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PreNan PTF per-gram values (Nestlé PreNan brand)
// Na/K converted from mg to mEq (Na÷23, K÷39.1). vitd kept as IU/g total (perDay nutrient).
const PTF_PRENAN = {
  energy: 4.93,    // kcal/g
  protein: 0.117,  // g/g
  fat: 0.248,      // g/g
  carb: 0.557,     // g/g
  ca: 6.1,         // mg/g
  po4: 3.05,       // mg/g
  fe: 0.09,        // mg/g
  vitd: 6.0,       // IU/g — divided by wt (kg) to give IU/kg/d
  na: 0.0957,      // mEq/g (2.2 mg/g ÷ 23)
  k: 0.1279,       // mEq/g (5.0 mg/g ÷ 39.1)
  mg: 0.37,        // mg/g
  zn: 0.032,       // mg/g
  vita: 59.27,     // IU/g
  vite: 0.18,      // IU/g
  vitk: 0.20,      // mcg/g
  vitc: 0.75,      // mg/g
  folic: 2.0,      // mcg/g
  cu: 4.4,         // mcg/g (0.0044 mg/g × 1000)
  thia: 0.007,     // mg/g
  ribo: 0.0089,    // mg/g
  nica: 0.09,      // mg/g
  pyri: 0.005,     // mg/g
};
const NUTRIENTS = [
  { k: "energy", n: "Energy", u: "kcal/kg", bm: 67, fm: 78, hm: 4, aap: [105, 130], esp: [115, 140] },
  { k: "protein", n: "Protein", u: "g/kg", bm: 1.1, fm: 1.9, hm: 0.3, aap: [3.5, 4.0], esp: [3.5, 4.5] },
  { k: "fat", n: "Fat", u: "g/kg", bm: 3.6, fm: 3.8, hm: 0.1, aap: [5.0, 7.0], esp: [4.8, 8.1] },
  { k: "carb", n: "Carbohydrate", u: "g/kg", bm: 6.7, fm: 8.1, hm: 0.4, aap: [10.0, 14], esp: [11.0, 15.0] },
  { k: "ca", n: "Calcium", u: "mg/kg/d", bm: 26, fm: 95, hm: 15.93, aap: [200, 210], esp: [120, 200], sup: true },
  { k: "po4", n: "Phosphorus", u: "mg/kg/d", bm: 13, fm: 48, hm: 8.76, aap: [100, 110], esp: [60, 115], sup: true },
  { k: "fe", n: "Iron", u: "mg/kg/d", bm: 0.12, fm: 1.67, hm: 0.36, aap: [2.0, 3.0], esp: [2.0, 3.0], sup: true },
  { k: "vitd", n: "Vitamin D", u: "IU/kg/d", bm: 2, fm: 160, hm: 28, aap: [400, 400], esp: [400, 700] },
  { k: "na", n: "Sodium", u: "mEq/kg/d", bm: 1.4, fm: 1.03, hm: 0.32, aap: [2.0, 3.0], esp: [3.0, 8.0] },
  { k: "k", n: "Potassium", u: "mEq/kg/d", bm: 2.4, fm: 0.74, hm: 0.25, aap: [1.7, 2.5], esp: [2.0, 5.0] },
  { k: "mg", n: "Magnesium", u: "mg/kg/d", bm: 3, fm: 3.7, hm: 0.8, esp: [9.0, 12.5] },
  { k: "zn", n: "Zinc", u: "mg/kg/d", bm: 0.33, fm: 0.28, hm: 0.19, aap: [0.6, 1.0], esp: [2.0, 3.0] },
  { k: "vita", n: "Vitamin A", u: "IU/kg/d", bm: 50, fm: 505, hm: 221.6, aap: [92, 270], esp: [1330, 3300] },
  { k: "vite", n: "Vitamin E", u: "IU/kg/d", bm: 1.5, fm: 1.11, hm: 1.12, aap: [1.3, 1.3], esp: [2.2, 11] },
  { k: "vitk", n: "Vitamin K", u: "mcg/kg/d", bm: 0.2, fm: 6.67, hm: 1.5, aap: [4.8, 4.8], esp: [4.4, 28] },
  { k: "vitc", n: "Vitamin C", u: "mg/kg/d", bm: 10.6, fm: 6.67, hm: 3.75, aap: [42, 42], esp: [11, 46] },
  { k: "folic", n: "Folic acid", u: "mcg/kg/d", bm: 3.3, fm: 16.7, hm: 7.5, aap: [40, 40], esp: [35, 100] },
  { k: "cu", n: "Copper", u: "mcg/kg/d", bm: 73, fm: 35.6, hm: 10, aap: [100, 108], esp: [120, 230] },
  { k: "thia", n: "Thiamine (B1)", u: "mg/kg/d", bm: 0.016, fm: 0.1, hm: 0.02, esp: [0.14, 0.29] },
  { k: "ribo", n: "Riboflavin (B2)", u: "mg/kg/d", bm: 0.037, fm: 0.1, hm: 0.03, esp: [0.2, 0.43] },
  { k: "nica", n: "Nicotinamide (B3)", u: "mg/kg/d", bm: 0.17, fm: 0.68, hm: 0.05, esp: [3.6, 4.8] },
  { k: "pyri", n: "Pyridoxine (B6)", u: "mg/kg/d", bm: 0.011, fm: 0.063, hm: 0.02, esp: [0.07, 0.29] },
];
function mergeNutDB(overrides) {
  if (!overrides) return NUTRIENTS;
  return NUTRIENTS.map(nut => {
    const ov = overrides[nut.k];
    if (!ov) return nut;
    return {
      ...nut,
      bm: ov.bm != null ? ov.bm : nut.bm,
      fm: ov.fm != null ? ov.fm : nut.fm,
      hm: ov.hm != null ? ov.hm : nut.hm,
      ptf: ov.ptf != null ? ov.ptf : (PTF_PRENAN[nut.k] ?? nut.hm),
      aap: ov.aap || nut.aap,
      esp: ov.esp || nut.esp,
    };
  });
}
function calcNutrition(ip, nutDB) {
  const db = nutDB || NUTRIENTS;
  const wt = ip.wtNow / 1000;
  if (wt <= 0) return null;
  const totalFeedMl = ip.mode === "feed" ? ip.perFeed * ip.feedsPerDay : ip.totalMlKg * wt;
  const feedMlKg = totalFeedMl / wt;
  const ebmMl = ip.feedSrc === "Formula" ? 0 : (ip.feedSrc === "Mixed" ? totalFeedMl * ip.ebmPct / 100 : totalFeedMl);
  const fmMl = ip.feedSrc === "EBM" ? 0 : (ip.feedSrc === "Mixed" ? totalFeedMl * (100 - ip.ebmPct) / 100 : totalFeedMl);
  const hmfG = ip.hmfMode === "feed" ? ip.hmfPerFeed * (ip.hmfFreq || 12) : ip.hmfPerDay;
  const wtGain = ip.wtLast > 0 ? ((ip.wtNow - ip.wtLast) / ((ip.wtNow + ip.wtLast) / 2)) * 1000 / 7 : 0;
  const rows = db.map(nut => {
    let fromEbm = ebmMl * nut.bm / 100;
    let fromFm = fmMl * nut.fm / 100;
    const hmVal = ip.fortType === "PTF" ? (nut.ptf ?? PTF_PRENAN[nut.k] ?? nut.hm) : nut.hm;
    let fromHmf = hmfG * hmVal;
    let fromSup = 0;
    if (nut.k === "ca") fromSup = (ip.caMl * (ip.caConcCa || 0)) + (ip.extraCaMgDay || 0);
    if (nut.k === "fe") fromSup = ip.feMl * ip.feConc;
    if (nut.k === "vitd") fromSup = (ip.vitdIU || 0) + (ip.mviMl || 0) * (ip.mviVitdPerMl || 400);
    if (nut.k === "po4") fromSup = (ip.caMl * (ip.caConcP || 0)) + (ip.extraPMgDay || 0);
    if (nut.k === "vita") fromSup = (ip.mviMl || 0) * (ip.mviVitaPerMl || 3000);
    if (nut.k === "vitc") fromSup = (ip.mviMl || 0) * (ip.mviVitcPerMl || 40);
    if (nut.k === "vite") fromSup = (ip.mviMl || 0) * (ip.mviVitePerMl || 5);
    if (nut.k === "zn") fromSup = (ip.mviMl || 0) * (ip.mviZnPerMl || 2.5);
    if (nut.k === "ribo") fromSup = (ip.mviMl || 0) * (ip.mviRiboPerMl || 1);
    if (nut.k === "nica") fromSup = (ip.mviMl || 0) * (ip.mviNicaPerMl || 10);
    if (nut.k === "pyri") fromSup = (ip.mviMl || 0) * (ip.mviPyriPerMl || 0.82);
    if (nut.k === "thia") fromSup = (ip.mviMl || 0) * (ip.mviThiaPerMl || 1.62);
    const totalAbs = fromEbm + fromFm + fromHmf + fromSup;
    const perKg = nut.perDay ? totalAbs : totalAbs / wt;
    const rda = nut.esp;
    let status = "ok";
    if (rda) { if (perKg < rda[0] * 0.95) status = "low"; else if (perKg > rda[1] * 1.05) status = "high" }
    return { ...nut, fromEbm, fromFm, fromHmf, fromSup, totalAbs, perKg, status };
  });
  const eRow = rows.find(r => r.k === "energy"), pRow = rows.find(r => r.k === "protein");
  const pe = eRow && pRow && eRow.perKg > 0 ? (pRow.perKg / eRow.perKg) * 100 : 0;
  return { rows, feedMlKg, totalFeedMl, ebmMl, fmMl, hmfG, wtGain, pe, wt };
}
function NutDBEditor({ T, nutOv, saveNutOv, fortType, onClose, onSupSaved }) {
  const [tab, setTab] = useState("bm");
  const [d, setD] = useState(() => {
    const init = {};
    NUTRIENTS.forEach(nut => {
      const ov = nutOv?.[nut.k] || {};
      init[nut.k] = {
        bm: ov.bm ?? nut.bm,
        fm: ov.fm ?? nut.fm,
        hm: ov.hm ?? nut.hm,                              // HMF values — always original
        ptf: ov.ptf ?? (PTF_PRENAN[nut.k] ?? nut.hm),    // PTF values — from PreNan or saved overrides
        aap: ov.aap ? [...ov.aap] : (nut.aap ? [...nut.aap] : [0, 0]),
        esp: ov.esp ? [...ov.esp] : (nut.esp ? [...nut.esp] : [0, 0])
      };
    });
    return init;
  });
  const [supDef, setSupDef] = useState(() => ({
    caConcCa: nutOv?.__supDef?.caConcCa ?? 16,
    caConcP: nutOv?.__supDef?.caConcP ?? 8,
    feConc: nutOv?.__supDef?.feConc ?? 10,
    mviVitaPerMl: nutOv?.__supDef?.mviVitaPerMl ?? 3000,
    mviVitdPerMl: nutOv?.__supDef?.mviVitdPerMl ?? 400,
    mviVitcPerMl: nutOv?.__supDef?.mviVitcPerMl ?? 40,
    mviVitePerMl: nutOv?.__supDef?.mviVitePerMl ?? 5,
    mviZnPerMl: nutOv?.__supDef?.mviZnPerMl ?? 2.5,
    mviRiboPerMl: nutOv?.__supDef?.mviRiboPerMl ?? 1,
    mviNicaPerMl: nutOv?.__supDef?.mviNicaPerMl ?? 10,
    mviPyriPerMl: nutOv?.__supDef?.mviPyriPerMl ?? 0.82,
    mviThiaPerMl: nutOv?.__supDef?.mviThiaPerMl ?? 1.62,
  }));
  const upd = (k, field, val) => {
    // When editing the fortifier tab, write to 'ptf' or 'hm' depending on active fortType
    const actualField = field === "hm" ? (fortType === "PTF" ? "ptf" : "hm") : field;
    setD(p => ({ ...p, [k]: { ...p[k], [actualField]: val } }));
  };
  const updRda = (k, field, idx, val) => setD(p => { const arr = [...(p[k][field] || [0, 0])]; arr[idx] = val; return { ...p, [k]: { ...p[k], [field]: arr } }; });
  const tabs = [{ id: "bm", l: "EBM", sub: "per 100 mL" }, { id: "fm", l: "Formula", sub: "per 100 mL" }, { id: "hm", l: fortType === "PTF" ? "PTF" : "HMF", sub: "per gram" }, { id: "sup", l: "Suppl.", sub: "defaults" }, { id: "aap", l: "AAP", sub: "RDA range" }, { id: "esp", l: "ESPGHAN 2022", sub: "RDA range" }];
  const isRda = tab === "aap" || tab === "esp";
  const isSup = tab === "sup";
  return <div style={{ background: T.card, borderRadius: 12, border: "1px solid " + T.border, boxShadow: T.shadow, marginBottom: 8, overflow: "hidden" }}>
    <div style={{ display: "flex", alignItems: "center", padding: "10px 12px", borderBottom: "1px solid " + T.border }}>
      <div style={{ flex: 1 }}><div style={{ fontSize: 13, fontWeight: 700, color: T.t1 }}>Nutrition Database</div><div style={{ fontSize: 10, color: T.t3 }}>Edit values and save as your defaults</div></div>
      <button onClick={onClose} style={{ width: 28, height: 28, borderRadius: 14, background: T.inp, border: "1px solid " + T.border, cursor: "pointer", fontSize: 14, color: T.t3, display: "flex", alignItems: "center", justifyContent: "center" }}>&times;</button>
    </div>
    <div style={{ display: "flex", gap: 2, padding: "6px 8px", overflowX: "auto", borderBottom: "1px solid " + T.border }}>
      {tabs.map(t => <button key={t.id} onClick={() => setTab(t.id)} style={{ padding: "6px 8px", fontSize: 9, fontWeight: tab === t.id ? 700 : 500, background: tab === t.id ? T.accentDim : "transparent", color: tab === t.id ? T.accentText : T.t3, border: tab === t.id ? "1px solid " + T.accent + "33" : "1px solid transparent", borderRadius: 6, cursor: "pointer", whiteSpace: "nowrap", textAlign: "center", lineHeight: 1.3 }}><div>{t.l}</div><div style={{ fontSize: 7, fontWeight: 400 }}>{t.sub}</div></button>)}
    </div>
    <div style={{ maxHeight: 320, overflowY: "auto", padding: "4px 8px" }}>
      {isSup ? <>
        {/* Supplement concentration defaults */}
        <div style={{ padding: "8px 4px 4px" }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: T.t1, marginBottom: 8 }}>Default supplement concentrations</div>
          <div style={{ fontSize: 10, fontWeight: 700, color: T.t3, marginBottom: 6, marginTop: 4, textTransform: "uppercase" }}>Ca/P &amp; Iron</div>
          {[
            { label: "Ca/P syrup — Ca conc.", key: "caConcCa", unit: "mg/mL", step: 1 },
            { label: "Ca/P syrup — P conc.", key: "caConcP", unit: "mg/mL", step: 1 },
            { label: "Iron conc.", key: "feConc", unit: "mg/mL", step: 1 },
          ].map(item => {
            const inpSt = { width: 80, height: 30, padding: "0 4px", fontSize: 12, fontWeight: 600, background: T.inp, border: "1.5px solid " + T.inpBorder, borderRadius: 6, color: T.t1, outline: "none", fontFamily: "'JetBrains Mono',monospace", boxSizing: "border-box", textAlign: "center" };
            return <div key={item.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "7px 4px", borderBottom: "1px solid " + T.border + "44" }}>
              <div><div style={{ fontSize: 11, fontWeight: 600, color: T.t1 }}>{item.label}</div><div style={{ fontSize: 8, color: T.t3 }}>{item.unit}</div></div>
              <input type="number" value={supDef[item.key]} onChange={e => setSupDef(p => ({ ...p, [item.key]: parseFloat(e.target.value) || 0 }))} onFocus={e => e.target.select()} step={item.step} style={inpSt} />
            </div>;
          })}
          <div style={{ fontSize: 10, fontWeight: 700, color: T.t3, marginBottom: 6, marginTop: 12, textTransform: "uppercase" }}>MVI (Multivitamin) — per mL</div>
          {[
            { label: "Vitamin A", key: "mviVitaPerMl", unit: "IU/mL", step: 100 },
            { label: "Vitamin D (Cholecalciferol)", key: "mviVitdPerMl", unit: "IU/mL", step: 50 },
            { label: "Vitamin C (Ascorbic Acid)", key: "mviVitcPerMl", unit: "mg/mL", step: 1 },
            { label: "Vitamin E (Tocopheryl Acetate)", key: "mviVitePerMl", unit: "IU/mL", step: 0.5 },
            { label: "Zinc (elemental)", key: "mviZnPerMl", unit: "mg/mL", step: 0.1 },
            { label: "Thiamine (B1) — as base", key: "mviThiaPerMl", unit: "mg/mL", step: 0.01 },
            { label: "Riboflavin (B2)", key: "mviRiboPerMl", unit: "mg/mL", step: 0.1 },
            { label: "Nicotinamide (B3)", key: "mviNicaPerMl", unit: "mg/mL", step: 0.5 },
            { label: "Pyridoxine (B6) — as base", key: "mviPyriPerMl", unit: "mg/mL", step: 0.01 },
          ].map(item => {
            const inpSt = { width: 80, height: 30, padding: "0 4px", fontSize: 12, fontWeight: 600, background: T.inp, border: "1.5px solid " + T.inpBorder, borderRadius: 6, color: T.t1, outline: "none", fontFamily: "'JetBrains Mono',monospace", boxSizing: "border-box", textAlign: "center" };
            return <div key={item.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "7px 4px", borderBottom: "1px solid " + T.border + "44" }}>
              <div><div style={{ fontSize: 11, fontWeight: 600, color: T.t1 }}>{item.label}</div><div style={{ fontSize: 8, color: T.t3 }}>{item.unit}</div></div>
              <input type="number" value={supDef[item.key]} onChange={e => setSupDef(p => ({ ...p, [item.key]: parseFloat(e.target.value) || 0 }))} onFocus={e => e.target.select()} step={item.step} style={inpSt} />
            </div>;
          })}
          <div style={{ fontSize: 9, color: T.t3, marginTop: 8, padding: "0 4px" }}>Default values based on Vi-syneral Z brand (0.5 mL/day for infants). Edit to match your current MVI brand.</div>
        </div>
      </> : <>
        {/* Header */}
        <div style={{ display: "grid", gridTemplateColumns: isRda ? "1fr 64px 64px" : "1fr 80px", gap: 4, padding: "4px 4px 2px", borderBottom: "1px solid " + T.border }}>
          <span style={{ fontSize: 9, fontWeight: 700, color: T.t3 }}>NUTRIENT</span>
          {isRda ? <><span style={{ fontSize: 9, fontWeight: 700, color: T.t3, textAlign: "center" }}>LOW</span><span style={{ fontSize: 9, fontWeight: 700, color: T.t3, textAlign: "center" }}>HIGH</span></> : <span style={{ fontSize: 9, fontWeight: 700, color: T.t3, textAlign: "center" }}>VALUE</span>}
        </div>
        {tab === "hm" && <div style={{ padding: "6px 4px 4px", borderBottom: "1px solid " + T.border + "44" }}>
          <div style={{ fontSize: 9, color: T.t3, marginBottom: 4 }}>
            {fortType === "PTF" ? <>Showing <span style={{ fontWeight: 700, color: T.accentText }}>PTF</span> values — defaults based on <span style={{ fontWeight: 600 }}>PreNan</span> brand. Edit below to customise.</> : <>Showing <span style={{ fontWeight: 700, color: T.green }}>HMF</span> values. Switch to PTF in Feeds to edit PTF values.</>}
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            <button onClick={() => { const upds = {}; NUTRIENTS.forEach(nut => { upds[nut.k] = { ...d[nut.k], ptf: PTF_PRENAN[nut.k] ?? nut.hm }; }); setD(upds); }} style={{ flex: 1, padding: "5px 8px", fontSize: 9, fontWeight: 700, background: fortType === "PTF" ? T.accentDim : T.card, color: fortType === "PTF" ? T.accentText : T.t3, border: "1px solid " + (fortType === "PTF" ? T.accent + "33" : T.border), borderRadius: 6, cursor: "pointer" }}>↺ Load PTF (PreNan)</button>
            <button onClick={() => { const upds = {}; NUTRIENTS.forEach(nut => { const ov = nutOv?.[nut.k] || {}; upds[nut.k] = { ...d[nut.k], hm: ov.hm ?? nut.hm }; }); setD(upds); }} style={{ flex: 1, padding: "5px 8px", fontSize: 9, fontWeight: 700, background: fortType === "HMF" ? T.green + "10" : T.card, color: fortType === "HMF" ? T.green : T.t3, border: "1px solid " + (fortType === "HMF" ? T.green + "33" : T.border), borderRadius: 6, cursor: "pointer" }}>↺ Load HMF defaults</button>
          </div>
        </div>}
        {NUTRIENTS.map(nut => {
          const val = d[nut.k];
          const inpSt = { width: "100%", height: 30, padding: "0 4px", fontSize: 12, fontWeight: 600, background: T.inp, border: "1.5px solid " + T.inpBorder, borderRadius: 6, color: T.t1, outline: "none", fontFamily: "'JetBrains Mono',monospace", boxSizing: "border-box", textAlign: "center" };
          const displayVal = (tab === "hm") ? (fortType === "PTF" ? val.ptf : val.hm) : val[tab];
          return <div key={nut.k} style={{ display: "grid", gridTemplateColumns: isRda ? "1fr 64px 64px" : "1fr 80px", gap: 4, padding: "5px 4px", borderBottom: "1px solid " + T.border + "44", alignItems: "center" }}>
            <div><div style={{ fontSize: 11, fontWeight: 600, color: T.t1 }}>{nut.n}</div><div style={{ fontSize: 8, color: T.t3 }}>{nut.u}</div></div>
            {isRda ? <>
              <input type="number" value={val[tab][0]} onChange={e => updRda(nut.k, tab, 0, parseFloat(e.target.value) || 0)} onFocus={e => e.target.select()} step={0.1} style={inpSt} />
              <input type="number" value={val[tab][1]} onChange={e => updRda(nut.k, tab, 1, parseFloat(e.target.value) || 0)} onFocus={e => e.target.select()} step={0.1} style={inpSt} />
            </> : <input type="number" value={displayVal} onChange={e => upd(nut.k, tab, parseFloat(e.target.value) || 0)} onFocus={e => e.target.select()} step={0.01} style={inpSt} />}
          </div>;
        })}
      </>}
    </div>
    <div style={{ display: "flex", gap: 6, padding: "8px 10px", borderTop: "1px solid " + T.border }}>
      <button onClick={() => { saveNutOv({ ...d, __supDef: supDef }); if (onSupSaved) onSupSaved(supDef); alert("Nutrition database saved!") }} style={{ flex: 1, padding: 10, fontSize: 13, fontWeight: 700, background: T.btnGrad, color: "#fff", border: "none", borderRadius: 8, cursor: "pointer" }}>Save Defaults</button>
      <button onClick={() => { saveNutOv(null); const init = {}; NUTRIENTS.forEach(nut => { init[nut.k] = { bm: nut.bm, fm: nut.fm, hm: nut.hm, ptf: PTF_PRENAN[nut.k] ?? nut.hm, aap: nut.aap ? [...nut.aap] : [0, 0], esp: nut.esp ? [...nut.esp] : [0, 0] }; }); setD(init); setSupDef({ caConcCa: 16, caConcP: 8, feConc: 10, mviVitaPerMl: 3000, mviVitdPerMl: 400, mviVitcPerMl: 40, mviVitePerMl: 5, mviZnPerMl: 2.5, mviRiboPerMl: 1, mviNicaPerMl: 10, mviPyriPerMl: 0.82, mviThiaPerMl: 1.62 }); alert("Reset to factory values!") }} style={{ padding: "10px 14px", fontSize: 11, fontWeight: 600, background: T.card, color: T.red, border: "1px solid " + T.red + "33", borderRadius: 8, cursor: "pointer" }}>Reset</button>
    </div>
  </div>;
}
function printNutritionAudit(ip, res, fortLabel) {
  const r1 = v => Math.round(v * 10) / 10;
  const fv = (v, d = 1) => r1(v).toFixed(d);
  const blank = (n = 8) => "_".repeat(n);

  // Hospital name
  let hospitalName = "LHMC & Associated Hospitals";
  try {
    const profile = JSON.parse(localStorage.getItem("user_profile") || "{}");
    if (profile.hospital) hospitalName = profile.hospital;
  } catch(e) {}

  // Date dd-mm-yyyy
  const formatDate = (d) => {
    if (!d) return blank(10);
    const p = d.split("-");
    return p.length === 3 ? `${p[2]}-${p[1]}-${p[0]}` : d;
  };

  // Advisory logic (mirrors screen)
  const grosslyLow = res.rows.filter(r => r.esp && r.esp[0] > 0 && r.perKg < r.esp[0] * 0.80);
  const keys = grosslyLow.map(r => r.k);
  const hasMacro = keys.some(k => ["energy","protein","fat","carb"].includes(k));
  const hasMVI   = keys.some(k => ["vita","vitc","vite","zn","ribo","nica","pyri","thia"].includes(k));
  const hasCaP   = keys.some(k => ["ca","po4"].includes(k));
  const hasFe    = keys.includes("fe");
  const hasVitD  = keys.includes("vitd");
  const hasNa    = keys.includes("na");
  const names    = grosslyLow.map(r => r.n).join(", ");
  const advLines = [];
  if (hasMVI && hasMacro) advLines.push("Optimise nutrition delivery: increase feed volume or HMF/PTF dose, and ensure MVI is given daily — this will address most macro and micronutrient gaps together.");
  else if (hasMacro) advLines.push("Increase total feed volume and/or HMF/PTF dose to meet calorie and macronutrient targets.");
  else if (hasMVI) advLines.push("Ensure MVI is given daily at recommended dose — it is the primary source of most deficient vitamins and trace elements.");
  if (hasCaP) advLines.push("Increase Ca/P syrup dose and HMF to address bone mineral deficits; give iron separately by ≥2 hours.");
  else if (hasFe) advLines.push("Start or increase elemental iron (target 2–3 mg/kg/d); give 2 hours apart from Ca/P supplement.");
  if (hasVitD) advLines.push("Supplement Vitamin D to reach ESPGHAN 2022 target of 400–700 IU/kg/d.");
  if (hasNa) advLines.push("Increase NaCl supplementation — target 3–5 mEq/kg/d per ESPGHAN 2022.");
  if (advLines.length === 0 && grosslyLow.length > 0) advLines.push("Review and optimise doses for: " + names + ".");

  // Status symbol for B&W print
  const stSym = st => st === "low" ? "▼" : st === "high" ? "▲" : "●";
  const stCls = st => st === "low" ? "low" : st === "high" ? "high" : "ok";

  // RDA display
  const rdaStr = rda => !rda ? "—" : rda[0] === rda[1] ? ">" + rda[0] : rda[0] + "–" + rda[1];

  // All nutrient rows as table HTML
  const nutrientRows = res.rows.map(r =>
    `<tr class="${stCls(r.status)}">
      <td>${stSym(r.status)} ${r.n}</td>
      <td class="unit">${r.u}</td>
      <td class="val">${r.perKg < 10 ? r.perKg.toFixed(1) : Math.round(r.perKg)}</td>
      <td class="rda">${rdaStr(r.esp)}</td>
    </tr>`
  ).join("");

  // Source breakdown rows (only key nutrients)
  const breakdownKeys = ["energy","protein","ca","po4","fe","vitd"];
  const breakdownRows = breakdownKeys.map(k => {
    const r = res.rows.find(x => x.k === k);
    if (!r) return "";
    const total = r.totalAbs || 1;
    const bars = [
      {l:"EBM", v: r.fromEbm}, {l:"Formula", v: r.fromFm},
      {l: fortLabel, v: r.fromHmf}, {l:"Suppl.", v: r.fromSup}
    ].filter(b => b.v > 0);
    const pcts = bars.map(b => `${b.l} ${Math.round(b.v/total*100)}%`).join(" · ");
    return `<tr>
      <td>${r.n}</td>
      <td class="unit">${r.u}</td>
      <td class="val">${r.perKg < 10 ? r.perKg.toFixed(1) : Math.round(r.perKg)}</td>
      <td class="src">${pcts || "—"}</td>
    </tr>`;
  }).join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>Nutrition Audit – B/o ${ip.babyOf || ""}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: Arial, sans-serif; font-size: 9.5pt; color: #000; padding: 8mm 10mm; }
  h1 { font-size: 13pt; font-weight: bold; text-align: center; margin-bottom: 2px; }
  h2 { font-size: 10.5pt; font-weight: bold; text-align: center; margin-bottom: 6px; }
  /* Header strip */
  .hdr { display: flex; border: 1.5px solid #000; margin-bottom: 6px; }
  .hdr-cell { flex: 1; padding: 4px 7px; border-right: 1px solid #000; font-size: 9pt; }
  .hdr-cell:last-child { border-right: none; }
  /* Two-column layout */
  .body-wrap { display: flex; gap: 8px; align-items: flex-start; }
  .col-left { flex: 1 1 0; min-width: 0; }
  .col-right { width: 190px; flex-shrink: 0; }
  /* Section label */
  .sec { font-size: 8.5pt; font-weight: bold; background: #e0e0e0; padding: 2px 6px; margin-bottom: 0; }
  /* Metrics strip */
  .metrics { display: flex; border: 1px solid #ccc; margin-bottom: 6px; }
  .metric { flex: 1; text-align: center; padding: 4px 2px; border-right: 1px solid #ccc; }
  .metric:last-child { border-right: none; }
  .metric .mv { font-size: 12pt; font-weight: bold; }
  .metric .ml { font-size: 7.5pt; color: #555; }
  .metric .mu { font-size: 7pt; color: #555; }
  /* Nutrient table */
  table.nut { width: 100%; border-collapse: collapse; font-size: 8.5pt; margin-bottom: 6px; }
  table.nut th { background: #e0e0e0; border: 1px solid #999; padding: 2px 4px; font-size: 8pt; text-align: left; }
  table.nut td { border: 1px solid #ccc; padding: 2px 4px; }
  table.nut .val { text-align: right; font-weight: bold; }
  table.nut .rda { text-align: right; color: #555; font-size: 8pt; min-width: 52px; }
  table.nut .unit { color: #666; font-size: 7.5pt; }
  table.nut tr.low td { background: #f5f5f5; }
  table.nut tr.low .val { color: #000; }
  table.nut tr.low td:first-child { font-weight: bold; }
  table.nut tr.high td:first-child { font-style: italic; }
  /* Source breakdown table */
  table.src { width: 100%; border-collapse: collapse; font-size: 8pt; margin-bottom: 6px; }
  table.src th { background: #e0e0e0; border: 1px solid #999; padding: 2px 4px; text-align: left; }
  table.src td { border: 1px solid #ccc; padding: 2px 4px; }
  table.src .val { text-align: right; font-weight: bold; }
  table.src .src { color: #555; font-size: 7.5pt; }
  /* Summary side table */
  table.sum { width: 100%; border-collapse: collapse; border: 1.5px solid #000; font-size: 9pt; }
  table.sum td { border: 1px solid #aaa; padding: 3px 5px; vertical-align: top; }
  table.sum td.sl { background: #f0f0f0; font-weight: bold; font-size: 8.5pt; width: 58%; }
  table.sum td.sv { text-align: right; font-size: 9pt; }
  table.sum td.unit { font-size: 7.5pt; font-weight: normal; color: #555; }
  table.sum tr.sec td { background: #e0e0e0; font-weight: bold; font-size: 8.5pt; padding: 2px 5px; }
  /* Advisory */
  .adv { border: 1.5px solid #555; padding: 6px 8px; margin-bottom: 6px; font-size: 8.5pt; }
  .adv .adv-title { font-weight: bold; font-size: 9pt; margin-bottom: 3px; }
  .adv .adv-sub { font-size: 7.5pt; color: #555; margin-bottom: 4px; }
  .adv-line { margin-bottom: 3px; padding-left: 10px; position: relative; }
  .adv-line::before { content: "→"; position: absolute; left: 0; font-weight: bold; }
  /* Legend */
  .legend { font-size: 7.5pt; color: #555; margin-bottom: 6px; }
  @media print { body { padding: 6mm 8mm; } @page { size: A4; margin: 6mm; } }
</style>
</head>
<body>
<h1>${hospitalName}</h1>
<h2>Neonatal Intensive Care Unit — Nutrition Audit Report</h2>

<div class="hdr">
  <div class="hdr-cell"><b>Baby of:</b> ${ip.babyOf || blank(16)}</div>
  <div class="hdr-cell"><b>Patient ID:</b> ${ip.patientId || blank(10)}</div>
  <div class="hdr-cell"><b>Date:</b> ${formatDate(ip.date)}</div>
  <div class="hdr-cell"><b>Weight:</b> ${ip.wtNow} g &nbsp;<span style="font-size:8pt;color:#555;">(prev: ${ip.wtLast} g)</span></div>
</div>

<!-- Key metrics strip -->
<div class="metrics">
  <div class="metric"><div class="mv">${res.wtGain.toFixed(1)}</div><div class="ml">Wt Gain</div><div class="mu">g/kg/d ${res.wtGain >= 15 ? "✓" : "⚠"}</div></div>
  <div class="metric"><div class="mv">${Math.round(res.rows.find(r=>r.k==="energy").perKg)}</div><div class="ml">Calories</div><div class="mu">kcal/kg</div></div>
  <div class="metric"><div class="mv">${fv(res.rows.find(r=>r.k==="protein").perKg)}</div><div class="ml">Protein</div><div class="mu">g/kg</div></div>
  <div class="metric"><div class="mv">${res.pe.toFixed(1)}</div><div class="ml">P:E Ratio</div><div class="mu">${res.pe < 2.6 || res.pe > 4.1 ? "⚠ target 2.6–4.1" : "✓ target 2.6–4.1"}</div></div>
  <div class="metric"><div class="mv">${fv(res.rows.find(r=>r.k==="ca")?.perKg ?? 0)}</div><div class="ml">Calcium</div><div class="mu">mg/kg</div></div>
  <div class="metric"><div class="mv">${fv(res.rows.find(r=>r.k==="po4")?.perKg ?? 0)}</div><div class="ml">Phosphorus</div><div class="mu">mg/kg</div></div>
</div>

<div class="body-wrap">

  <!-- LEFT: nutrient table + advisory + breakdown -->
  <div class="col-left">

    <div class="sec">Nutrient Audit &nbsp;·&nbsp; <span style="font-weight:normal;">▼ below RDA &nbsp; ▲ above RDA &nbsp; ● adequate</span></div>
    <table class="nut">
      <tr><th style="width:38%;">Nutrient</th><th>Unit</th><th style="text-align:right;">Intake</th><th style="text-align:right;white-space:nowrap;">ESPGHAN 2022</th></tr>
      ${nutrientRows}
    </table>

    ${grosslyLow.length > 0 ? `
    <div class="adv">
      <div class="adv-title">⚠ Deficiency Advisory</div>
      <div class="adv-sub">${grosslyLow.length} nutrient${grosslyLow.length > 1 ? "s" : ""} below ESPGHAN 2022 RDA (&lt;80%): ${names}</div>
      ${advLines.map(l => `<div class="adv-line">${l}</div>`).join("")}
    </div>` : `<div style="font-size:8.5pt;padding:5px 6px;border:1px solid #ccc;margin-bottom:6px;">✓ All audited nutrients within ESPGHAN 2022 RDA</div>`}

    <div class="sec" style="margin-bottom:2px;">Source Breakdown (key nutrients)</div>
    <table class="src">
      <tr><th>Nutrient</th><th>Unit</th><th style="text-align:right;">Intake</th><th>Sources (% contribution)</th></tr>
      ${breakdownRows}
    </table>

  </div>

  <!-- RIGHT: summary inputs -->
  <div class="col-right">
    <table class="sum">
      <tr class="sec"><td colspan="2">Feed Details</td></tr>
      <tr><td class="sl">Source</td><td class="sv">${ip.feedSrc}</td></tr>
      <tr><td class="sl">Volume <span class="unit">mL/kg/d</span></td><td class="sv"><b>${Math.round(res.feedMlKg)}</b></td></tr>
      <tr><td class="sl">${fortLabel} <span class="unit">g/d</span></td><td class="sv"><b>${fv(res.hmfG)}</b></td></tr>

      <tr class="sec"><td colspan="2">Weight</td></tr>
      <tr><td class="sl">Current <span class="unit">g</span></td><td class="sv"><b>${ip.wtNow}</b></td></tr>
      <tr><td class="sl">Previous <span class="unit">g</span></td><td class="sv"><b>${ip.wtLast}</b></td></tr>
      <tr><td class="sl">Gain <span class="unit">g/kg/d</span></td><td class="sv"><b>${res.wtGain.toFixed(1)}</b></td></tr>

      <tr class="sec"><td colspan="2">Supplements</td></tr>
      ${r1(ip.caMl) > 0 ? `<tr><td class="sl">Ca/P syrup <span class="unit">mL/d</span></td><td class="sv"><b>${fv(ip.caMl)}</b></td></tr>` : ""}
      ${r1(ip.feMl) > 0 ? `<tr><td class="sl">Iron <span class="unit">mL/d</span></td><td class="sv"><b>${fv(ip.feMl)}</b></td></tr>` : ""}
      ${r1(ip.vitdIU) > 0 ? `<tr><td class="sl">Vit D <span class="unit">IU/d</span></td><td class="sv"><b>${Math.round(ip.vitdIU)}</b></td></tr>` : ""}
      ${r1(ip.mviMl) > 0 ? `<tr><td class="sl">MVI <span class="unit">mL/d</span></td><td class="sv"><b>${fv(ip.mviMl)}</b></td></tr>` : ""}

      <tr class="sec"><td colspan="2">Summary</td></tr>
      <tr><td class="sl">Calories <span class="unit">kcal/kg</span></td><td class="sv"><b>${Math.round(res.rows.find(r=>r.k==="energy").perKg)}</b></td></tr>
      <tr><td class="sl">Protein <span class="unit">g/kg</span></td><td class="sv"><b>${fv(res.rows.find(r=>r.k==="protein").perKg)}</b></td></tr>
      <tr><td class="sl">P:E Ratio</td><td class="sv"><b>${res.pe.toFixed(1)}</b></td></tr>
      <tr><td class="sl">Deficiencies</td><td class="sv"><b>${grosslyLow.length}</b></td></tr>
    </table>

    <div style="margin-top:8px;font-size:7.5pt;color:#555;line-height:1.5;">
      <b>RDA source:</b> ESPGHAN 2022<br>
      ▼ Below RDA (&lt;80%) &nbsp; ▲ Above RDA<br>
      ● Within range
    </div>
  </div>

</div>

<script>window.onload = function() { window.print(); };</script>
</body>
</html>`;

  const w = window.open("", "_blank", "width=860,height=1100");
  if (!w) { alert("Pop-up blocked. Please allow pop-ups for this site."); return; }
  w.document.write(html);
  w.document.close();
}

function NutritionPage({ T, defaults, nutOv, saveNutOv }) {
  const [ip, setIp] = useState({
    babyOf: "", patientId: "", date: todayStr(), wtNow: 1500, wtLast: 1400, mode: "day", perFeed: 15, feedsPerDay: 12, totalMlKg: 150,
    feedSrc: "EBM", ebmPct: 70, hmfMode: "day", hmfPerFeed: 0, hmfPerDay: 0, hmfFreq: 12,
    caMl: 0, caConcCa: nutOv?.__supDef?.caConcCa ?? 16, caConcP: nutOv?.__supDef?.caConcP ?? 8, feMl: 0, feConc: nutOv?.__supDef?.feConc ?? 10, extraCaMgDay: 0, extraPMgDay: 0, vitdIU: 400,
    fortType: "HMF",
    mviMl: 0,
    mviVitaPerMl: nutOv?.__supDef?.mviVitaPerMl ?? 3000,
    mviVitdPerMl: nutOv?.__supDef?.mviVitdPerMl ?? 400,
    mviVitcPerMl: nutOv?.__supDef?.mviVitcPerMl ?? 40,
    mviVitePerMl: nutOv?.__supDef?.mviVitePerMl ?? 5,
    mviZnPerMl: nutOv?.__supDef?.mviZnPerMl ?? 2.5,
    mviRiboPerMl: nutOv?.__supDef?.mviRiboPerMl ?? 1,
    mviNicaPerMl: nutOv?.__supDef?.mviNicaPerMl ?? 10,
    mviPyriPerMl: nutOv?.__supDef?.mviPyriPerMl ?? 0.82,
    mviThiaPerMl: nutOv?.__supDef?.mviThiaPerMl ?? 1.62
  });
  const [show, setShow] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const s = k => v => setIp(p => ({ ...p, [k]: v }));
  const nutDB = useMemo(() => mergeNutDB(nutOv), [nutOv]);
  const res = useMemo(() => calcNutrition(ip, nutDB), [ip, nutDB]);
  const fortLabel = ip.fortType === "PTF" ? "PTF" : "HMF";

  const [babyNutHist, setBabyNutHist] = useState([]);
  useEffect(() => { (async () => { try { const raw = await storeGet("nut_audit_history"); if (raw) { const all = JSON.parse(raw); const cutoff = Date.now() - 30 * 86400000; setBabyNutHist(all.filter(b => new Date(b.ts).getTime() > cutoff)) } } catch { } })() }, []);

  const saveNutAudit = async () => {
    if (!ip.babyOf || !ip.babyOf.trim()) { alert("Mother's name is required to save."); return; }
    if (!ip.patientId || !ip.patientId.trim()) { alert("Patient ID is required to save."); return; }
    const entry = { babyOf: ip.babyOf, patientId: ip.patientId, inputs: { ...ip }, results: res, ts: new Date().toISOString() };
    const updated = [entry, ...babyNutHist.filter(b => !(b.babyOf === ip.babyOf && b.patientId === ip.patientId && b.inputs?.date === ip.date))].slice(0, 200);
    try { await storeSet("nut_audit_history", JSON.stringify(updated)); setBabyNutHist(updated); alert("Nutrition audit saved!") } catch { alert("Save failed") }
  };
  const statusColor = (st) => st === "low" ? T.red : st === "high" ? T.blue : T.green;
  const statusBg = (st) => st === "low" ? T.red + "0c" : st === "high" ? T.blueBg : T.green + "08";

  return <div>
    <div style={{ background: T.card, borderRadius: 12, border: "1px solid " + T.border, marginBottom: 8, padding: "10px 12px", boxShadow: T.shadow }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
        <div><label style={{ fontSize: 10, color: T.t3, fontWeight: 600, textTransform: "uppercase", display: "block", marginBottom: 4 }}>Baby of (Mother)</label><input value={ip.babyOf} onChange={e => s("babyOf")(e.target.value)} placeholder="Mother's name" style={{ width: "100%", height: 38, padding: "0 6px", fontSize: 12, fontWeight: 600, background: T.inp, border: "1.5px solid " + T.inpBorder, borderRadius: 8, color: T.t1, outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} /></div>
        <div><label style={{ fontSize: 10, color: T.t3, fontWeight: 600, textTransform: "uppercase", display: "block", marginBottom: 4 }}>Patient ID</label><input value={ip.patientId} onChange={e => s("patientId")(e.target.value.replace(/\D/g, ""))} placeholder="Numeric" inputMode="numeric" style={{ width: "100%", height: 38, padding: "0 6px", fontSize: 13, fontWeight: 600, background: T.inp, border: "1.5px solid " + T.inpBorder, borderRadius: 8, color: T.t1, outline: "none", fontFamily: "'JetBrains Mono',monospace", boxSizing: "border-box" }} /></div>
        <div><label style={{ fontSize: 10, color: T.t3, fontWeight: 600, textTransform: "uppercase", display: "block", marginBottom: 4 }}>Date</label><input type="date" value={ip.date} onChange={e => s("date")(e.target.value)} style={{ width: "100%", height: 38, padding: "0 4px", fontSize: 11, fontWeight: 600, background: T.inp, border: "1.5px solid " + T.inpBorder, borderRadius: 8, color: T.t1, outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} /></div>
      </div>
    </div>
    <Sec title="Weight & Growth" open={true} onToggle={() => { }} T={T}>
      <Row><NI label="Today's weight" unit="g" value={ip.wtNow} onChange={s("wtNow")} step={10} T={T} /><NI label="Last week weight" unit="g" value={ip.wtLast} onChange={s("wtLast")} step={10} T={T} /></Row>
      {res && ip.wtLast > 0 && <div style={{ padding: "6px 10px", background: res.wtGain >= 15 ? T.green + "12" : T.amber + "12", borderRadius: 8, fontSize: 12, display: "flex", justifyContent: "space-between" }}>
        <span style={{ color: T.t2 }}>Weight gain</span>
        <span style={{ fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", color: res.wtGain >= 15 ? T.green : T.amber }}>{res.wtGain.toFixed(1)} g/kg/d</span>
      </div>}
    </Sec>

    <Sec title="Feeds" open={true} onToggle={() => { }} T={T}>
      <Row><Pills label="Entry mode" value={ip.mode} options={[{ label: "Per Feed", value: "feed" }, { label: "Per Day", value: "day" }]} onChange={s("mode")} T={T} /></Row>
      {ip.mode === "feed" ? <Row><NI label="mL per feed" unit="mL" value={ip.perFeed} onChange={s("perFeed")} step={1} T={T} /><NI label="Feeds/day" unit="" value={ip.feedsPerDay} onChange={s("feedsPerDay")} step={1} min={1} max={12} T={T} /></Row>
        : <Row><NI label="Total feeds" unit="mL/kg/d" value={ip.totalMlKg} onChange={s("totalMlKg")} step={5} T={T} /></Row>}
      <Row><Pills label="Feed source" value={ip.feedSrc} options={["EBM", "Formula", "Mixed"]} onChange={s("feedSrc")} T={T} /></Row>
      {ip.feedSrc === "Mixed" && <Row><NI label="EBM %" unit="%" value={ip.ebmPct} onChange={s("ebmPct")} step={5} min={0} max={100} T={T} /></Row>}
      <Row>
        <Pills label="Fortifier type" value={ip.fortType} options={[{ label: "HMF", value: "HMF" }, { label: "PTF", value: "PTF" }]} onChange={s("fortType")} T={T} />
      </Row>
      <Row><Pills label={fortLabel + " entry"} value={ip.hmfMode} options={[{ label: "Per Feed", value: "feed" }, { label: "Per Day", value: "day" }]} onChange={s("hmfMode")} T={T} />
        {ip.hmfMode === "feed" ? <NI label={fortLabel + "/feed"} unit="g" value={ip.hmfPerFeed} onChange={s("hmfPerFeed")} step={0.1} T={T} /> : <NI label={fortLabel + "/day"} unit="g" value={ip.hmfPerDay} onChange={s("hmfPerDay")} step={0.5} T={T} />}
      </Row>
      {ip.hmfMode === "feed" && <Row><Pills label="Feed frequency" value={ip.hmfFreq} options={[{ label: "2 hourly (12)", value: 12 }, { label: "3 hourly (8)", value: 8 }]} onChange={s("hmfFreq")} T={T} /></Row>}
    </Sec>

    <Sec title="Supplements" open={true} onToggle={() => { }} T={T}>
      <Row><NI label="Ca/P syrup" unit="mL/d" value={ip.caMl} onChange={s("caMl")} step={0.1} T={T} /><CaPConc caVal={ip.caConcCa} onCaChange={s("caConcCa")} pVal={ip.caConcP} onPChange={s("caConcP")} T={T} /></Row>
      <Row><NI label="Iron syrup" unit="mL/d" value={ip.feMl} onChange={s("feMl")} step={0.1} T={T} /><NI label="Iron conc." unit="mg/mL" value={ip.feConc} onChange={s("feConc")} step={1} T={T} /></Row>
      <Row><NI label="Extra calcium" unit="mg/d" value={ip.extraCaMgDay} onChange={s("extraCaMgDay")} step={5} T={T} /><NI label="Extra phosphate" unit="mg/d" value={ip.extraPMgDay} onChange={s("extraPMgDay")} step={5} T={T} /></Row>
      <Row><NI label="Vitamin D" unit="IU/d" value={ip.vitdIU} onChange={s("vitdIU")} step={100} T={T} /></Row>
      <Row><NI label="MVI (Multivitamin)" unit="mL/d" value={ip.mviMl} onChange={s("mviMl")} step={0.1} T={T} /></Row>
      {ip.mviMl > 0 && <div style={{ padding: "6px 10px", background: T.accentDim, borderRadius: 8, fontSize: 10, color: T.t3, marginBottom: 6, lineHeight: 1.7 }}>
        <span style={{ fontWeight: 600, color: T.accentText }}>MVI contributes: </span>VitA {r1(ip.mviMl * ip.mviVitaPerMl)} IU · VitD {r1(ip.mviMl * ip.mviVitdPerMl)} IU · VitC {r1(ip.mviMl * ip.mviVitcPerMl)} mg · VitE {r1(ip.mviMl * ip.mviVitePerMl)} IU · Zn {r1(ip.mviMl * ip.mviZnPerMl)} mg · B1 {r1(ip.mviMl * ip.mviThiaPerMl)} mg · B2 {r1(ip.mviMl * ip.mviRiboPerMl)} mg · B3 {r1(ip.mviMl * ip.mviNicaPerMl)} mg · B6 {r1(ip.mviMl * ip.mviPyriPerMl)} mg
      </div>}
    </Sec>

    <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
      <button onClick={() => setEditing(!editing)} style={{ flex: 1, padding: "10px 12px", fontSize: 12, fontWeight: 600, background: editing ? T.accentDim : T.card, color: editing ? T.accentText : T.t2, border: "1px solid " + (editing ? T.accent + "44" : T.border), borderRadius: 10, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        {editing ? "Close Editor" : "Edit Nutrition Database"}
      </button>
    </div>

    {editing && <NutDBEditor T={T} nutOv={nutOv} saveNutOv={saveNutOv} fortType={ip.fortType} onClose={() => setEditing(false)} onSupSaved={sd => { if (sd.caConcCa != null) s("caConcCa")(sd.caConcCa); if (sd.caConcP != null) s("caConcP")(sd.caConcP); if (sd.feConc != null) s("feConc")(sd.feConc); }} />}

    <button onClick={() => setShow(true)} style={{ width: "100%", padding: 14, fontSize: 15, fontWeight: 700, background: T.btnGrad, color: "#fff", border: "none", borderRadius: 12, cursor: "pointer", marginBottom: 12, boxShadow: "0 4px 16px " + T.accent + "33" }}>Audit Nutrition</button>

    {show && res && <div style={{ animation: "fadeIn .35s ease" }}>
      {(ip.babyOf || ip.patientId || ip.date) && <div style={{ background: T.card, borderRadius: 10, padding: "8px 12px", marginBottom: 8, border: "1px solid " + T.border, display: "flex", justifyContent: "space-between", fontSize: 12, flexWrap: "wrap", gap: 4 }}>
        {ip.babyOf && <span style={{ color: T.t1, fontWeight: 600 }}>Baby of {ip.babyOf}</span>}
        {ip.patientId && <span style={{ color: T.t3 }}>ID: {ip.patientId}</span>}
        {ip.date && <span style={{ color: T.t3 }}>{ip.date}</span>}
      </div>}
      {/* Key metrics */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 8 }}>
        <Metric label="Calories" val={r1(res.rows.find(r => r.k === "energy").perKg).toFixed(0)} unit="kcal/kg" color={T.accent} T={T} warn={res.rows.find(r => r.k === "energy").status === "low" ? "mid" : undefined} />
        <Metric label="Protein" val={r1(res.rows.find(r => r.k === "protein").perKg).toFixed(1)} unit="g/kg" color={T.green} T={T} />
        <Metric label="P:E ratio" val={res.pe.toFixed(1)} unit="g/100kcal" color={T.purple} T={T} warn={res.pe < 2.6 || res.pe > 4.1 ? "mid" : undefined} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 8 }}>
        <Metric label="Feed vol" val={r1(res.feedMlKg).toFixed(0)} unit="mL/kg" color={T.accent} T={T} />
        <Metric label={fortLabel} val={r1(res.hmfG).toFixed(1)} unit="g/d" color={T.green} T={T} />
        <Metric label="Wt gain" val={res.wtGain.toFixed(1)} unit="g/kg/d" color={res.wtGain >= 15 ? T.green : T.amber} T={T} />
      </div>

      {/* Nutrient table */}
      <div style={{ background: T.card, borderRadius: 12, border: "1px solid " + T.border, boxShadow: T.shadow, marginBottom: 8, overflow: "hidden" }}>
        <div style={{ padding: "10px 12px", borderBottom: "1px solid " + T.border }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: T.t1 }}>Nutrient Audit</div>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: ip.fortType === "PTF" ? T.accentDim : T.green + "15", color: ip.fortType === "PTF" ? T.accentText : T.green, border: "1px solid " + (ip.fortType === "PTF" ? T.accent + "33" : T.green + "33") }}>{fortLabel}</span>
              <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: T.inp, color: T.t3 }}>{ip.feedSrc}</span>
            </div>
          </div>
          <div style={{ fontSize: 10, color: T.t3 }}>Color-coded vs ESPGHAN 2022 RDA</div>
        </div>
        {/* Header */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 62px 82px", gap: 4, padding: "6px 10px", borderBottom: "1px solid " + T.border, background: T.inp }}>
          <span style={{ fontSize: 9, fontWeight: 700, color: T.t3 }}>NUTRIENT</span>
          <span style={{ fontSize: 9, fontWeight: 700, color: T.t3, textAlign: "right" }}>INTAKE</span>
          <span style={{ fontSize: 9, fontWeight: 700, color: T.t3, textAlign: "right" }}>ESPGHAN 2022</span>
        </div>
        {(expanded ? res.rows : res.rows.slice(0, 8)).map((r, i) => {
          const sc = statusColor(r.status);
          const bg = statusBg(r.status);
          const rdaStr = rda => rda ? (rda[0] === rda[1] ? ">" + rda[0] : rda[0] + "-" + rda[1]) : "-";
          return <div key={r.k} style={{ display: "grid", gridTemplateColumns: "1fr 62px 82px", gap: 4, padding: "7px 10px", borderBottom: i < (expanded ? res.rows.length : 8) - 1 ? "1px solid " + T.border + "44" : "none", alignItems: "center", background: bg }}>
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <div style={{ width: 6, height: 6, borderRadius: 3, background: sc, flexShrink: 0 }} />
              <div><div style={{ fontSize: 11, fontWeight: 600, color: T.t1 }}>{r.n}</div><div style={{ fontSize: 8, color: T.t3 }}>{r.u}</div></div>
            </div>
            <div style={{ textAlign: "right" }}><span style={{ fontSize: 12, fontWeight: 700, color: sc, fontFamily: "'JetBrains Mono',monospace" }}>{r.perKg < 10 ? r.perKg.toFixed(1) : Math.round(r.perKg)}</span></div>
            <div style={{ textAlign: "right", fontSize: 9, color: T.t3 }}>{rdaStr(r.esp)}</div>
          </div>;
        })}
        {res.rows.length > 8 && <button onClick={() => setExpanded(!expanded)} style={{ width: "100%", padding: "8px 0", fontSize: 11, fontWeight: 600, color: T.accentText, background: T.accentDim, border: "none", cursor: "pointer" }}>{expanded ? "Show less" : "Show all " + res.rows.length + " nutrients"}</button>}
      </div>

      {/* Deficiency Advisory */}
      {(() => {
        const grosslyLow = res.rows.filter(r => {
          if (!r.esp || r.esp[0] === 0) return false;
          return r.perKg < r.esp[0] * 0.80;
        });
        if (grosslyLow.length === 0) return null;

        // Build smart consolidated advice based on pattern of deficiencies
        const keys = grosslyLow.map(r => r.k);
        const hasMacro = keys.some(k => ["energy", "protein", "fat", "carb"].includes(k));
        const hasMVI = keys.some(k => ["vita", "vitc", "vite", "zn", "ribo", "nica", "pyri", "thia"].includes(k));
        const hasCaP = keys.some(k => ["ca", "po4"].includes(k));
        const hasFe = keys.includes("fe");
        const hasVitD = keys.includes("vitd");
        const hasNa = keys.includes("na");
        const names = grosslyLow.map(r => r.n).join(", ");

        const lines = [];
        if (hasMVI && hasMacro) lines.push("Optimise nutrition delivery: increase feed volume or HMF/PTF dose, and ensure MVI is given daily — this will address most macro and micronutrient gaps together.");
        else if (hasMacro) lines.push("Increase total feed volume and/or HMF/PTF dose to meet calorie and macronutrient targets.");
        else if (hasMVI) lines.push("Ensure MVI is given daily at recommended dose — it is the primary source of most deficient vitamins and trace elements.");
        if (hasCaP) lines.push("Increase Ca/P syrup dose and HMF to address bone mineral deficits; give iron separately by ≥2 hours.");
        else if (hasFe) lines.push("Start or increase elemental iron (target 2–3 mg/kg/d); give 2 hours apart from Ca/P supplement.");
        if (hasVitD) lines.push("Supplement Vitamin D to reach ESPGHAN 2022 target of 400–700 IU/kg/d (typically 400–800 IU/day regardless of weight).");
        if (hasNa) lines.push("Increase NaCl supplementation — check serum sodium and target 3–5 mEq/kg/d per ESPGHAN 2022.");
        if (lines.length === 0) lines.push("Review and optimise doses for: " + names + ".");

        return <div style={{ background: T.card, borderRadius: 12, border: "1.5px solid " + T.amber + "55", boxShadow: T.shadow, marginBottom: 8, overflow: "hidden" }}>
          <div style={{ padding: "10px 12px", background: T.amber + "12", borderBottom: "1px solid " + T.amber + "30", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 18 }}>⚠️</span>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: T.amber }}>Deficiency Advisory</div>
              <div style={{ fontSize: 10, color: T.t3 }}>{grosslyLow.length} nutrient{grosslyLow.length > 1 ? "s" : ""} below ESPGHAN 2022 RDA (&lt;80%): {names}</div>
            </div>
          </div>
          <div style={{ padding: "12px 14px" }}>
            {lines.map((line, i) => <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: i < lines.length - 1 ? 8 : 0 }}>
              <span style={{ color: T.amber, fontWeight: 700, fontSize: 13, flexShrink: 0, marginTop: 1 }}>→</span>
              <span style={{ fontSize: 12, color: T.t1, lineHeight: 1.6 }}>{line}</span>
            </div>)}
          </div>
        </div>;
      })()}

      {/* Breakdown for key nutrients */}
      <div style={{ background: T.card, borderRadius: 12, padding: 10, border: "1px solid " + T.border, boxShadow: T.shadow, marginBottom: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: T.t1, marginBottom: 6 }}>Source Breakdown</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 4 }}>
          {["energy", "protein", "ca", "po4", "fe", "vitd"].map(k => {
            const r = res.rows.find(x => x.k === k); if (!r) return null;
            const total = r.totalAbs || 1;
            const bars = [{ l: "EBM", v: r.fromEbm, c: T.accent }, { l: "Formula", v: r.fromFm, c: T.green }, { l: fortLabel, v: r.fromHmf, c: T.purple }, { l: "Suppl.", v: r.fromSup, c: T.amber }].filter(b => b.v > 0);
            return <div key={k} style={{ padding: "4px 0" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, marginBottom: 3 }}>
                <span style={{ fontWeight: 600, color: T.t2 }}>{r.n}</span>
                <span style={{ fontFamily: "'JetBrains Mono',monospace", fontWeight: 600, color: T.t1 }}>{r.perKg < 10 ? r.perKg.toFixed(1) : Math.round(r.perKg)} {r.u}</span>
              </div>
              <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", background: T.inp }}>
                {bars.map((b, i) => <div key={i} title={b.l + ": " + r1(b.v).toFixed(1)} style={{ width: (b.v / total * 100) + "%", background: b.c, minWidth: b.v > 0 ? 2 : 0 }} />)}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 2 }}>{bars.map((b, i) => <span key={i} style={{ fontSize: 8, color: b.c, fontWeight: 600 }}>{b.l} {Math.round(b.v / total * 100)}%</span>)}</div>
            </div>;
          })}
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 9, color: T.t3 }}><div style={{ width: 6, height: 6, borderRadius: 3, background: T.green }} /> Adequate</div>
        <div style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 9, color: T.t3 }}><div style={{ width: 6, height: 6, borderRadius: 3, background: T.red }} /> Below RDA</div>
        <div style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 9, color: T.t3 }}><div style={{ width: 6, height: 6, borderRadius: 3, background: T.blue }} /> Above RDA</div>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 8, marginBottom: 16 }}>
        <button onClick={saveNutAudit} style={{ flex: 1, padding: 12, fontSize: 13, fontWeight: 700, background: T.card, color: T.accentText, border: "1.5px solid " + T.accent + "33", borderRadius: 10, cursor: "pointer" }}>💾 Save</button>
        <button onClick={() => printNutritionAudit(ip, res, fortLabel)} style={{ flex: 1, padding: 12, fontSize: 13, fontWeight: 700, background: T.card, color: T.t2, border: "1.5px solid " + T.border, borderRadius: 10, cursor: "pointer" }}>🖨️ Print</button>
      </div>
    </div>}
  </div>;
}
function SettingsPage({ T, defaults, saveDefaults }) {
  const [d, setD] = useState({ ...defaults }); const s = k => v => setD(p => ({ ...p, [k]: v }));
  return <div style={{ background: T.card, borderRadius: 12, padding: 16, border: "1px solid " + T.border, boxShadow: T.shadow }}>
    <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 700, color: T.t1 }}>Default Settings</h3><p style={{ fontSize: 12, color: T.t3, margin: "0 0 16px" }}>Pre-filled for every new calculation.</p>
    <Row><NI label="Weight" unit="g" value={d.weightG} onChange={s("weightG")} step={10} T={T} /><NI label="TFR" unit="mL/kg/d" value={d.tfr} onChange={s("tfr")} step={5} T={T} /><NI label="Feeds" unit="mL/kg/d" value={d.feeds} onChange={s("feeds")} step={5} T={T} /></Row>
    <Row><NI label="Amino acids" unit="g/kg/d" value={d.aminoAcid} onChange={s("aminoAcid")} step={.25} T={T} /><NI label="Lipids" unit="g/kg/d" value={d.lipid} onChange={s("lipid")} step={.25} T={T} /><NI label="GIR" unit="mg/kg/min" value={d.gir} onChange={s("gir")} step={.5} T={T} /></Row>
    <Row><NI label="Na" unit="mEq/kg/d" value={d.sodium} onChange={s("sodium")} step={.5} T={T} /><NI label="K" unit="mEq/kg/d" value={d.potassium} onChange={s("potassium")} step={.5} T={T} /></Row>
    <Row><Pills label="AA source" value={d.aaSource} options={["Aminoven", "Pentamin"]} onChange={s("aaSource")} T={T} /><Pills label="Na source" value={d.naSource} options={[{ label: "3% NaCl", value: "3% NaCl" }, { label: "Conc. RL", value: "CRL" }]} onChange={s("naSource")} T={T} /></Row>
    <Row><NI label="Celcel" unit="mL/kg/d" value={d.celcel} onChange={s("celcel")} step={.5} max={1.5} T={T} /><NI label="MVI" unit="mL/kg/d" value={d.mvi} onChange={s("mvi")} step={.5} max={1.5} T={T} /><NI label="Overfill" unit="x" value={d.overfill} onChange={s("overfill")} step={.05} min={1} max={1.5} T={T} /></Row>
    <div style={{ borderTop: "1px solid " + T.border, marginTop: 8, paddingTop: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: T.t1, marginBottom: 8 }}>Feed Nutrition (per 100 mL)</div>
      <Row><NI label="EBM cal" unit="kcal" value={d.ebmCal100} onChange={s("ebmCal100")} step={1} min={0} T={T} /><NI label="Formula cal" unit="kcal" value={d.formulaCal100} onChange={s("formulaCal100")} step={1} min={0} T={T} /></Row>
      <Row><NI label="EBM protein" unit="g" value={d.ebmProt100} onChange={s("ebmProt100")} step={0.05} min={0} T={T} /><NI label="Formula protein" unit="g" value={d.formulaProt100} onChange={s("formulaProt100")} step={0.05} min={0} T={T} /></Row>
    </div>
    <div style={{ borderTop: "1px solid " + T.border, marginTop: 8, paddingTop: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: T.t1, marginBottom: 4 }}>{(d.hmfProtPerG || 0) < 0.2 ? "PTF" : "HMF"} Nutrition (per gram)</div>
      <div style={{ fontSize: 10, color: T.t3, marginBottom: 8 }}>Full = 1g/25mL, Half = 1g/50mL, Quarter = 1g/100mL{"\n"}Protein &lt; 0.2 g/g → shows as PTF, ≥ 0.2 → HMF</div>
      <Row><NI label="Calories" unit="kcal/g" value={d.hmfCalPerG} onChange={s("hmfCalPerG")} step={0.5} min={0} T={T} /><NI label="Protein" unit="g/g" value={d.hmfProtPerG} onChange={s("hmfProtPerG")} step={0.05} min={0} T={T} /></Row>
    </div>
    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
      <button onClick={() => { saveDefaults(d); alert("Saved!") }} style={{ flex: 1, padding: 12, fontSize: 14, fontWeight: 700, background: T.btnGrad, color: "#fff", border: "none", borderRadius: 10, cursor: "pointer" }}>Save Defaults</button>
      <button onClick={() => { setD({ ...FACTORY }); saveDefaults({ ...FACTORY }); alert("Reset!") }} style={{ padding: "12px 16px", fontSize: 12, fontWeight: 600, background: T.card, color: T.red, border: "1px solid " + T.red + "33", borderRadius: 10, cursor: "pointer" }}>Factory Reset</button>
    </div>
  </div>;
}
function ProfilePage({ T }) {
  const COUNTRIES = ["Afghanistan", "Albania", "Algeria", "Andorra", "Angola", "Antigua and Barbuda", "Argentina", "Armenia", "Australia", "Austria", "Azerbaijan", "Bahamas", "Bahrain", "Bangladesh", "Barbados", "Belarus", "Belgium", "Belize", "Benin", "Bhutan", "Bolivia", "Bosnia and Herzegovina", "Botswana", "Brazil", "Brunei", "Bulgaria", "Burkina Faso", "Burundi", "Cabo Verde", "Cambodia", "Cameroon", "Canada", "Central African Republic", "Chad", "Chile", "China", "Colombia", "Comoros", "Congo", "Costa Rica", "Croatia", "Cuba", "Cyprus", "Czech Republic", "Denmark", "Djibouti", "Dominica", "Dominican Republic", "Ecuador", "Egypt", "El Salvador", "Equatorial Guinea", "Eritrea", "Estonia", "Eswatini", "Ethiopia", "Fiji", "Finland", "France", "Gabon", "Gambia", "Georgia", "Germany", "Ghana", "Greece", "Grenada", "Guatemala", "Guinea", "Guinea-Bissau", "Guyana", "Haiti", "Honduras", "Hungary", "Iceland", "India", "Indonesia", "Iran", "Iraq", "Ireland", "Israel", "Italy", "Jamaica", "Japan", "Jordan", "Kazakhstan", "Kenya", "Kiribati", "Korea North", "Korea South", "Kosovo", "Kuwait", "Kyrgyzstan", "Laos", "Latvia", "Lebanon", "Lesotho", "Liberia", "Libya", "Liechtenstein", "Lithuania", "Luxembourg", "Madagascar", "Malawi", "Malaysia", "Maldives", "Mali", "Malta", "Marshall Islands", "Mauritania", "Mauritius", "Mexico", "Micronesia", "Moldova", "Monaco", "Mongolia", "Montenegro", "Morocco", "Mozambique", "Myanmar", "Namibia", "Nauru", "Nepal", "Netherlands", "New Zealand", "Nicaragua", "Niger", "Nigeria", "North Macedonia", "Norway", "Oman", "Pakistan", "Palau", "Palestine", "Panama", "Papua New Guinea", "Paraguay", "Peru", "Philippines", "Poland", "Portugal", "Qatar", "Romania", "Russia", "Rwanda", "Saint Kitts and Nevis", "Saint Lucia", "Saint Vincent and the Grenadines", "Samoa", "San Marino", "Sao Tome and Principe", "Saudi Arabia", "Senegal", "Serbia", "Seychelles", "Sierra Leone", "Singapore", "Slovakia", "Slovenia", "Solomon Islands", "Somalia", "South Africa", "South Sudan", "Spain", "Sri Lanka", "Sudan", "Suriname", "Sweden", "Switzerland", "Syria", "Taiwan", "Tajikistan", "Tanzania", "Thailand", "Timor-Leste", "Togo", "Tonga", "Trinidad and Tobago", "Tunisia", "Turkey", "Turkmenistan", "Tuvalu", "Uganda", "Ukraine", "United Arab Emirates", "United Kingdom", "United States", "Uruguay", "Uzbekistan", "Vanuatu", "Vatican City", "Venezuela", "Vietnam", "Yemen", "Zambia", "Zimbabwe"];
  const DESIG = ["Junior Resident / PG", "Senior Resident / DM Resident", "Faculty", "Nurse", "Others"];
  const UNITS = ["NICU", "PICU", "Pediatric Surgery ICU", "Children Ward", "Others"];
  const blank = { name: "", sex: "", email: "", mobile: "", designation: "", unit: "NICU", hospital: "", city: "", country: "India" };
  const [p, saveP, ld] = useStore("user_profile", blank);
  const [f, setF] = useState(blank);
  const [cq, setCq] = useState("");
  const [cOpen, setCOpen] = useState(false);
  useEffect(() => { if (ld) setF(p) }, [ld, p]);
  const s = k => v => setF(prev => ({ ...prev, [k]: v }));
  const inp = { width: "100%", height: 38, padding: "0 10px", fontSize: 13, fontWeight: 600, background: T.inp, border: "1.5px solid " + T.inpBorder, borderRadius: 8, color: T.t1, outline: "none", fontFamily: "inherit", boxSizing: "border-box" };
  const sel = { ...inp, cursor: "pointer", WebkitAppearance: "none", appearance: "none", backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23999'/%3E%3C/svg%3E\")", backgroundRepeat: "no-repeat", backgroundPosition: "right 10px center" };
  const lbl = { fontSize: 10, color: T.t3, fontWeight: 600, textTransform: "uppercase", display: "block", marginBottom: 4 };
  const filteredCountries = cq.length > 0 ? COUNTRIES.filter(c => c.toLowerCase().startsWith(cq.toLowerCase())).slice(0, 6) : [];
  const canSave = f.email && f.email.includes("@");

  return <div style={{ background: T.card, borderRadius: 12, padding: 16, border: "1px solid " + T.border, boxShadow: T.shadow }}>
    <h3 style={{ margin: "0 0 16px", fontSize: 16, fontWeight: 700, color: T.t1 }}>Profile</h3>

    <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, marginBottom: 10 }}>
      <div><label style={lbl}>Name</label><input value={f.name} onChange={e => s("name")(e.target.value)} placeholder="Full name" style={inp} /></div>
      <div style={{ width: 100 }}><label style={lbl}>Sex</label><select value={f.sex || ""} onChange={e => s("sex")(e.target.value)} style={sel}><option value="">Select</option><option value="Male">Male</option><option value="Female">Female</option></select></div>
    </div>

    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
      <div><label style={lbl}>Email <span style={{ color: T.red, fontSize: 8 }}>*</span></label><input type="email" value={f.email} onChange={e => s("email")(e.target.value)} placeholder="Required" style={{ ...inp, borderColor: f.email && !f.email.includes("@") ? T.red + "66" : T.inpBorder }} /></div>
      <div><label style={lbl}>Mobile</label><input type="tel" value={f.mobile} onChange={e => s("mobile")(e.target.value.replace(/[^\d+\- ]/g, ""))} placeholder="Optional" style={inp} /></div>
    </div>

    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
      <div><label style={lbl}>Designation</label><select value={f.designation} onChange={e => s("designation")(e.target.value)} style={sel}><option value="">Select...</option>{DESIG.map(d => <option key={d} value={d}>{d}</option>)}</select></div>
      <div><label style={lbl}>Unit</label><select value={f.unit} onChange={e => s("unit")(e.target.value)} style={sel}>{UNITS.map(u => <option key={u} value={u}>{u}</option>)}</select></div>
    </div>

    <div style={{ marginBottom: 10 }}><label style={lbl}>Hospital</label><input value={f.hospital} onChange={e => s("hospital")(e.target.value)} placeholder="Hospital name" style={inp} /></div>

    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
      <div><label style={lbl}>City</label><input value={f.city} onChange={e => s("city")(e.target.value)} placeholder="City" style={inp} /></div>
      <div style={{ position: "relative" }}><label style={lbl}>Country</label><input value={cOpen ? cq : f.country} onChange={e => { setCq(e.target.value); setCOpen(true); if (!e.target.value) s("country")("") }} onFocus={() => { setCq(""); setCOpen(true) }} onBlur={() => setTimeout(() => setCOpen(false), 150)} placeholder="Type to search..." style={inp} />
        {cOpen && filteredCountries.length > 0 && <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 50, background: T.card, border: "1.5px solid " + T.accent + "44", borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,.15)", maxHeight: 160, overflowY: "auto", marginTop: 2 }}>
          {filteredCountries.map(c => <div key={c} onMouseDown={() => { s("country")(c); setCq(c); setCOpen(false) }} style={{ padding: "8px 10px", fontSize: 12, color: T.t1, cursor: "pointer", borderBottom: "1px solid " + T.border + "44" }} onMouseEnter={e => e.currentTarget.style.background = T.accentDim} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>{c}</div>)}
        </div>}
      </div>
    </div>

    <button onClick={() => { if (!canSave) { alert("Email is required."); return; } saveP(f); supabaseUpsertProfile(f); alert("Saved!") }} style={{ width: "100%", padding: 12, fontSize: 14, fontWeight: 700, background: canSave ? T.btnGrad : T.inpBorder, color: "#fff", border: "none", borderRadius: 10, cursor: canSave ? "pointer" : "not-allowed", marginTop: 8 }}>Save Profile</button>
  </div>;
}
function AboutPage({ T }) {
  const card = { background: T.card, borderRadius: 12, padding: "18px 18px", border: "1px solid " + T.border, boxShadow: T.shadow, marginBottom: 8 };
  return <div>
    <div style={{ ...card, display: "flex", flexDirection: "column", alignItems: "center", padding: "28px 18px 18px" }}>
      <Logo T={T} width={240} />
      <div style={{ fontSize: 13, color: T.t3, marginTop: 8 }}>v{APP_VERSION} ({APP_UPDATED})</div>
    </div>

    <div style={card}>
      <div style={{ fontSize: 15, fontWeight: 700, color: T.accentText, marginBottom: 10 }}>About NeoFORT</div>
      <p style={{ fontSize: 14, color: T.t2, lineHeight: 1.8, margin: "0 0 12px" }}>NeoFORT (Neonatal Fluid Optimisation & Review Tool) is a clinician-designed digital platform developed to support evidence-based neonatal nutrition and bedside decision-making in NICU settings.</p>
      <p style={{ fontSize: 14, color: T.t2, lineHeight: 1.8, margin: "0 0 8px" }}>Version {APP_VERSION} currently includes:</p>
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {["30 sec TPN", "GIR Calculator", "Nutrition Audit"].map((t, i) => <div key={i} style={{ flex: 1, padding: "10px 6px", background: T.accentDim, borderRadius: 8, border: "1px solid " + T.accent + "18", textAlign: "center", fontSize: 12, fontWeight: 600, color: T.accentText }}>{t}</div>)}
      </div>
      <p style={{ fontSize: 14, color: T.t2, lineHeight: 1.8, margin: 0 }}>NeoFORT is designed to reduce calculation errors, save bedside time, and promote structured documentation in neonatal units.</p>
    </div>

    <div style={card}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginBottom: 14 }}>
        <img src="/dev_photo.jpeg" alt="Dr. Vivek Kumar" style={{ width: 120, height: 120, borderRadius: "50%", objectFit: "cover", border: "3px solid " + T.accent + "33", marginBottom: 12 }} />
        <div style={{ fontSize: 15, fontWeight: 700, color: T.accentText }}>About the Developer</div>
      </div>
      <p style={{ fontSize: 14, color: T.t2, lineHeight: 1.8, margin: "0 0 10px" }}>Dr. Vivek Kumar is a neonatologist and currently an Assistant Professor at Lady Hardinge Medical College (LHMC), New Delhi. He completed his medical training (MBBS, MD, and DM) at AIIMS, New Delhi.</p>
      <p style={{ fontSize: 14, color: T.t2, lineHeight: 1.8, margin: 0 }}>NeoFORT is a personal, independent project born from his interest in the application of digital technology and Artificial Intelligence to enhance neonatal care.</p>
      <div style={{ textAlign: "center", marginTop: 16 }}>
        <a href={siteLink("about")} target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13.5, color: T.t2, textDecoration: "none", padding: "9px 14px", borderRadius: 8, border: "1px solid " + T.accent + "33", background: T.accentDim }}>
          Explore more at <span style={{ color: T.accentText, fontWeight: 700 }}>{SITE_LABEL}</span>
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" style={{ opacity: .7 }}><path d="M4 2h6v6M10 2L3 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </a>
      </div>
    </div>

    <div style={{ ...card, background: T.accentDim, border: "1px solid " + T.accent + "25", padding: "18px 20px" }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: T.accentText, marginBottom: 8, letterSpacing: ".03em", textTransform: "uppercase" }}>A note from the developer</div>
      <p style={{ fontSize: 13, color: T.t2, lineHeight: 1.9, margin: "0 0 8px", fontStyle: "italic" }}>"In neonatal care, small numbers carry great weight. A minor miscalculation can affect a life measured in grams. NeoFORT was first conceptualized during my DM training at AIIMS, New Delhi, where I developed Excel-based calculators that continue to be used in clinical practice at AIIMS and other centers.</p>
      <p style={{ fontSize: 13, color: T.t2, lineHeight: 1.9, margin: "0 0 8px", fontStyle: "italic" }}>Over time, it became clear that thoughtfully designed digital tools could further enhance safety, efficiency, and standardization in the NICU. NeoFORT represents the evolution of that early work into a clinician-friendly application, developed with the assistance of modern digital technologies.</p>
      <p style={{ fontSize: 13, color: T.t2, lineHeight: 1.9, margin: "0 0 8px", fontStyle: "italic" }}>It is my hope that this platform supports colleagues in delivering precise, efficient, and compassionate care to the smallest patients we serve."</p>
      <p style={{ fontSize: 14, color: T.accentText, fontWeight: 700, margin: 0, textAlign: "right" }}>— Dr. Vivek Kumar</p>
    </div>
  </div>;
}
function PrivacyPage({ T }) {
  const card = { background: T.card, borderRadius: 12, padding: "18px 18px", border: "1px solid " + T.border, boxShadow: T.shadow, marginBottom: 8 };
  return <div>
    <div style={{ ...card, display: "flex", alignItems: "center", gap: 12, padding: "20px 18px" }}>
      <div style={{ width: 44, height: 44, borderRadius: 10, background: T.btnGrad, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, flexShrink: 0 }}>{"\ud83d\udd12"}</div>
      <div><div style={{ fontSize: 17, fontWeight: 700, color: T.t1 }}>Privacy & Disclaimer</div><div style={{ fontSize: 13, color: T.t3, marginTop: 2 }}>How your data is handled</div></div>
    </div>

    <div style={card}>
      <div style={{ fontSize: 15, fontWeight: 700, color: T.accentText, marginBottom: 10 }}>Privacy Policy</div>
      <p style={{ fontSize: 14, color: T.t2, lineHeight: 1.85, margin: "0 0 14px" }}>All clinical data — including TPN calculations, nutrition audits, and patient-related entries — is processed and stored locally on your device only. No patient-identifiable health data is collected or transmitted to any external server.</p>
      <p style={{ fontSize: 14, color: T.t2, lineHeight: 1.85, margin: "0 0 14px" }}>No analytics, tracking cookies, or advertising services are used.</p>

      <div style={{ fontSize: 15, fontWeight: 700, color: T.accentText, marginBottom: 10, marginTop: 18, paddingTop: 14, borderTop: "1px solid " + T.border }}>Data We Collect</div>
      <p style={{ fontSize: 14, color: T.t2, lineHeight: 1.85, margin: "0 0 10px" }}>When you set up your profile, basic information (name, email, hospital, city) is stored both locally and synced to our server to enable cross-device access. This data is used solely for app functionality and is never shared with third parties.</p>
      <p style={{ fontSize: 14, color: T.t2, lineHeight: 1.85, margin: "0 0 10px" }}>Feedback submissions (via the Contact Us form) are sent to our server to help improve the application.</p>
      <p style={{ fontSize: 14, color: T.t2, lineHeight: 1.85, margin: "0 0 0" }}>No patient data, TPN calculations, or nutrition audit data ever leaves your device.</p>
    </div>

    <div style={{ ...card, border: "1px solid " + T.red + "22", background: T.card }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: T.red, marginBottom: 10 }}>Disclaimer</div>
      <p style={{ fontSize: 14, color: T.t2, lineHeight: 1.85, margin: "0 0 12px" }}>This application is intended as a calculation aid only. All outputs must be independently verified by the treating physician before clinical use.</p>
      <p style={{ fontSize: 14, color: T.t2, lineHeight: 1.85, margin: "0 0 12px" }}>The developers assume no liability for any clinical decisions, actions, or outcomes based on information provided by this application.</p>
      <p style={{ fontSize: 14, color: T.t2, lineHeight: 1.85, margin: 0 }}>NeoFORT does not replace clinical judgment, institutional protocols, or established medical guidelines. It is meant to assist — not to direct — neonatal nutritional management.</p>
    </div>
  </div>;
}
function FAQPage({ T }) {
  const [openIdx, setOpenIdx] = useState(null);
  const toggle = i => setOpenIdx(openIdx === i ? null : i);
  const card = { background: T.card, borderRadius: 12, padding: "18px 18px", border: "1px solid " + T.border, boxShadow: T.shadow, marginBottom: 8 };
  const faqs = [
    { q: "What is NeoFORT?", a: "NeoFORT (Neonatal Fluid Optimisation & Review Tool) is a clinician-designed app for NICU teams that helps with TPN calculations, GIR/dextrose calculations, and structured nutrition audits. It was developed by Dr. Vivek Kumar (Assistant Professor, LHMC, New Delhi) to reduce bedside calculation errors and save time." },
    { q: "Is NeoFORT free to use?", a: "Yes. NeoFORT is completely free for all healthcare professionals. There are no subscriptions, ads, or in-app purchases." },
    { q: "Is my patient data safe?", a: "All clinical data — TPN calculations, nutrition audits, and baby-related entries — stays entirely on your device. No patient data is transmitted to any server. Only your profile info (name, email, hospital) is synced for cross-device access. See the Privacy & Disclaimer page for full details." },
    { q: "What are 'Default Settings' and how do they work?", a: "Default Settings (accessible via the Settings page in the hamburger menu) let you pre-fill values that auto-populate every new TPN calculation. This saves time because you don't have to re-enter your unit's standard protocols each time.\n\nFactory defaults include: Weight 1000g, TFR 100 mL/kg/d, Feeds 0 (NPO), Amino acids 3 g/kg/d, Lipids 3 g/kg/d, GIR 6 mg/kg/min, Na 3 mEq/kg/d, K 2 mEq/kg/d, AA source Aminoven, Na source 3% NaCl, MVI 1 mL/kg/d, Celcel 0, Overfill 1x.\n\nYou can customize these to match your NICU's preferred starting values, and hit 'Factory Reset' anytime to restore the original defaults." },
    { q: "What does the 'Overfill' setting mean?", a: "Overfill controls how syringe volumes are displayed:\n• Overfill = 1: Volumes are shown as 'Per 50 mL' (for making in a standard 50 mL syringe).\n• Overfill > 1 (e.g. 1.1 or 1.2): Full-day volumes are calculated with 10–20% extra to account for syringe priming and line dead-space. The output then shows both the base volume and the adjusted volume." },
    { q: "What is the difference between 2-syringe and 3-syringe TPN?", a: "In 2-syringe mode:\n• Syringe 1 = Lipid + MVI + Celcel\n• Syringe 2 = Amino acids + Electrolytes + Dextrose\n\nIn 3-syringe mode:\n• Syringe 1 = Lipid + MVI + Celcel\n• Syringe 2 = Amino acids + Electrolytes only\n• Syringe 3 = Dextrose only\n\n3-syringe mode is useful when you want to titrate dextrose separately (e.g. for glucose instability)." },
    { q: "What is the difference between Aminoven and Pentamin?", a: "Both are 10% amino acid solutions used for neonatal TPN.\n• Aminoven: Pure amino acids with no added electrolytes.\n• Pentamin: Contains 8.7 mEq Na and 1.5 mEq K per 100 mL.\n\nThe calculator automatically adjusts Na and K volumes when Pentamin is selected, so you get the correct final electrolyte delivery." },
    { q: "What does '3% NaCl' vs 'Conc. RL (CRL)' mean?", a: "These are two sodium sources for TPN:\n• 3% NaCl: Standard hypertonic saline (0.51 mEq Na/mL).\n• Conc. RL (Concentrated Ringer Lactate): Alternative preparation (~1.5 mEq Na/mL), resulting in smaller volumes.\n\nChoose whichever is available at your institution. The calculator adjusts volumes accordingly." },
    { q: "Can I use NeoFORT offline?", a: "Yes. Once the app is loaded in your browser, all calculators work fully offline. TPN calculations, GIR calculations, and nutrition audits do not require an internet connection. An internet connection is only needed the very first time you open the app and during profile setup." },
    { q: "What is the GIR Calculator used for?", a: "The GIR (Glucose Infusion Rate) Calculator helps you determine the dextrose concentration needed to achieve a target GIR based on available fluid volume, or conversely, what GIR a given dextrose setup will deliver. It's useful for quick bedside glucose management decisions independent of full TPN planning." },
    { q: "What is the Nutrition Audit tool?", a: "The Nutrition Audit tool lets you track and document actual nutritional intake (calories, protein, fluids) a baby received over a day. It helps identify gaps between prescribed and delivered nutrition, supporting quality improvement and structured documentation." },
    { q: "How do HMF/PTF settings work?", a: "In Settings, you configure the calories and protein per gram of your Human Milk Fortifier (HMF) or Protein-Targeted Fortifier (PTF).\n• If protein per gram ≥ 0.2 g/g → labeled as HMF\n• If protein per gram < 0.2 g/g → labeled as PTF\n\nStrength options (Quarter / Half / Full) correspond to 1g per 100 mL, 1g per 50 mL, and 1g per 25 mL of feeds respectively. The app automatically calculates additional calories and protein from fortification." },
    { q: "What do the EBM and Formula calorie/protein defaults mean?", a: "These are the assumed nutritional values per 100 mL of enteral feeds:\n• EBM (Expressed Breast Milk): Default 67 kcal and 1.1 g protein per 100 mL.\n• Formula: Default 78 kcal and 1.9 g protein per 100 mL.\n\nYou can adjust these in Settings to match the specific products used at your center." },
    { q: "Can multiple people use NeoFORT on the same device?", a: "NeoFORT currently supports a single profile per device/browser. If multiple users share a device, they will share the same profile and default settings. Each user should ideally use their own device or browser for accurate profile tracking." },
    { q: "How do I report a bug or suggest a feature?", a: "Use the Contact Us page (accessible from the hamburger menu). Select the feedback type (Bug Report, Feature Request, etc.), describe the issue, and submit. Your feedback is saved locally and also sent to the developer. You can also reach out directly via email at vivekneoaiims@gmail.com." },
  ];
  return <div>
    <div style={{ ...card, display: "flex", alignItems: "center", gap: 12, padding: "20px 18px" }}>
      <div style={{ width: 44, height: 44, borderRadius: 10, background: T.btnGrad, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, flexShrink: 0 }}>{"\u2753"}</div>
      <div><div style={{ fontSize: 17, fontWeight: 700, color: T.t1 }}>Frequently Asked Questions</div><div style={{ fontSize: 13, color: T.t3, marginTop: 2 }}>{faqs.length} questions answered</div></div>
    </div>

    {faqs.map((f, i) => {
      const isOpen = openIdx === i;
      return <div key={i} style={{ background: T.card, borderRadius: 12, border: "1px solid " + (isOpen ? T.accent + "44" : T.border), boxShadow: T.shadow, marginBottom: 6, transition: "border-color .2s" }}>
        <button onClick={() => toggle(i)} style={{ width: "100%", display: "flex", alignItems: "center", padding: "14px 16px", background: "transparent", border: "none", cursor: "pointer", textAlign: "left", gap: 10 }}>
          <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: isOpen ? T.accentText : T.t1, lineHeight: 1.5, transition: "color .2s" }}>{f.q}</span>
          <svg width="18" height="18" viewBox="0 0 18 18" style={{ flexShrink: 0, transform: isOpen ? "rotate(180deg)" : "rotate(0)", transition: "transform .25s ease", color: isOpen ? T.accentText : T.t3 }}><path d="M4.5 6.75L9 11.25L13.5 6.75" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        {isOpen && <div style={{ padding: "0 16px 16px", fontSize: 13, color: T.t2, lineHeight: 1.85, whiteSpace: "pre-line", borderTop: "1px solid " + T.border + "66", marginLeft: 16, marginRight: 16, paddingTop: 12 }}>{f.a}</div>}
      </div>;
    })}
  </div>;
}
function ContactPage({ T }) {
  const TYPES = ["Bug Report", "Feature Request", "Calculation Issue", "UI/UX Feedback", "General Query", "Other"];
  const PRIORITY = ["Low", "Medium", "High"];
  const [profile] = useStore("user_profile", {});
  const [type, setType] = useState("");
  const [priority, setPriority] = useState("Medium");
  const [subject, setSubject] = useState("");
  const [msg, setMsg] = useState("");
  const [sent, setSent] = useState(false);
  const [history, setHistory] = useState([]);
  const [showHist, setShowHist] = useState(false);

  useEffect(() => { (async () => { try { const raw = await storeGet("feedback_history"); if (raw) setHistory(JSON.parse(raw)) } catch { } })() }, []);

  const inp = { width: "100%", height: 38, padding: "0 10px", fontSize: 13, fontWeight: 600, background: T.inp, border: "1.5px solid " + T.inpBorder, borderRadius: 8, color: T.t1, outline: "none", fontFamily: "inherit", boxSizing: "border-box" };
  const sel = { ...inp, cursor: "pointer", WebkitAppearance: "none", appearance: "none", backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23999'/%3E%3C/svg%3E\")", backgroundRepeat: "no-repeat", backgroundPosition: "right 10px center" };
  const lbl = { fontSize: 10, color: T.t3, fontWeight: 600, textTransform: "uppercase", display: "block", marginBottom: 4 };
  const canSend = type && subject.trim() && msg.trim();

  const doSend = async () => {
    const ua = navigator.userAgent || "";
    const isMob = /Mobile|Android|iPhone/i.test(ua);
    const entry = {
      type, priority, subject, message: msg,
      timestamp: new Date().toISOString(),
      appVersion: APP_NAME_VERSION,
      device: isMob ? "Mobile" : "Desktop",
      browser: /Chrome/.test(ua) ? "Chrome" : /Safari/.test(ua) ? "Safari" : /Firefox/.test(ua) ? "Firefox" : "Other",
      screen: window.screen.width + "x" + window.screen.height,
      profile: { name: profile.name || "", email: profile.email || "", designation: profile.designation || "", unit: profile.unit || "", hospital: profile.hospital || "", city: profile.city || "", country: profile.country || "" }
    };
    // Save locally
    const updated = [entry, ...history].slice(0, 20);
    try { await storeSet("feedback_history", JSON.stringify(updated)) } catch { }
    setHistory(updated);
    // Send to Supabase via proxy
    try {
      await fetch("/api/feedback", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          type, priority, subject, message: msg,
          profile_name: profile.name || "", profile_email: profile.email || "", profile_designation: profile.designation || "", profile_hospital: profile.hospital || "", profile_city: profile.city || "",
          device_id: getDeviceId(), device: entry.device, browser: entry.browser, screen: entry.screen, app_version: APP_NAME_VERSION
        })
      });
    } catch (e) { console.warn("Feedback sync failed:", e); }
    setSent(true);
    setTimeout(() => { setSent(false); setType(""); setSubject(""); setMsg(""); setPriority("Medium") }, 3000);
  };

  return <div>
    {/* Header card */}
    <div style={{ background: T.card, borderRadius: 12, padding: 16, border: "1px solid " + T.border, boxShadow: T.shadow, marginBottom: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <div style={{ width: 40, height: 40, borderRadius: 10, background: T.btnGrad, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>{"\ud83d\udce7"}</div>
        <div><div style={{ fontSize: 16, fontWeight: 700, color: T.t1 }}>Contact & Feedback</div><div style={{ fontSize: 11, color: T.t3 }}>Help us improve NeoFORT</div></div>
      </div>
      <a href={siteLink("contact")} target="_blank" rel="noopener noreferrer" style={{ display: "block", marginBottom: 12, fontSize: 12.5, color: T.t2, textDecoration: "none", lineHeight: 1.6, textAlign: "center" }}>
        Visit at <span style={{ color: T.accentText, fontWeight: 700 }}>{SITE_LABEL}</span> to explore more
      </a>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
        <div style={{ padding: "10px 12px", background: T.accentDim, borderRadius: 8, border: "1px solid " + T.accent + "20" }}>
          <div style={{ fontSize: 9, color: T.t3, fontWeight: 600, textTransform: "uppercase", marginBottom: 2 }}>Email</div>
          <div style={{ fontSize: 11, color: T.accentText, fontWeight: 600 }}>vivekneoaiims@gmail.com</div>
        </div>
        <div style={{ padding: "10px 12px", background: T.accentDim, borderRadius: 8, border: "1px solid " + T.accent + "20" }}>
          <div style={{ fontSize: 9, color: T.t3, fontWeight: 600, textTransform: "uppercase", marginBottom: 2 }}>Twitter / X</div>
          <div style={{ fontSize: 11, color: T.accentText, fontWeight: 600 }}>@VivekNeoAiims</div>
        </div>
        <div style={{ padding: "10px 12px", background: T.accentDim, borderRadius: 8, border: "1px solid " + T.accent + "20" }}>
          <div style={{ fontSize: 9, color: T.t3, fontWeight: 600, textTransform: "uppercase", marginBottom: 2 }}>Location</div>
          <div style={{ fontSize: 11, color: T.accentText, fontWeight: 600 }}>New Delhi</div>
        </div>
      </div>
    </div>

    {/* Feedback form */}
    <div style={{ background: T.card, borderRadius: 12, padding: 16, border: "1px solid " + T.border, boxShadow: T.shadow, marginBottom: 8 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: T.t1, marginBottom: 12 }}>Send Feedback</div>

      {sent ? <div style={{ textAlign: "center", padding: "24px 0" }}>
        <div style={{ fontSize: 36, marginBottom: 8 }}>{"\u2705"}</div>
        <div style={{ fontSize: 15, fontWeight: 700, color: T.green, marginBottom: 4 }}>Feedback Saved!</div>
        <div style={{ fontSize: 12, color: T.t3 }}>Thank you for helping us improve.</div>
      </div> : <>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
          <div><label style={lbl}>Type <span style={{ color: T.red, fontSize: 8 }}>*</span></label><select value={type} onChange={e => setType(e.target.value)} style={sel}><option value="">Select type...</option>{TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select></div>
          <div><label style={lbl}>Priority</label>
            <div style={{ display: "flex", gap: 2, background: T.inp, borderRadius: 8, padding: 2, height: 38, alignItems: "stretch" }}>
              {PRIORITY.map(pr => { const on = priority === pr; const col = pr === "High" ? T.red : pr === "Medium" ? T.amber : T.green; return <button key={pr} onClick={() => setPriority(pr)} style={{ flex: 1, fontSize: 10, fontWeight: on ? 700 : 500, background: on ? col + "15" : "transparent", color: on ? col : T.t3, border: on ? "1px solid " + col + "33" : "1px solid transparent", borderRadius: 6, cursor: "pointer" }}>{pr}</button> })}
            </div>
          </div>
        </div>
        <div style={{ marginBottom: 10 }}><label style={lbl}>Subject <span style={{ color: T.red, fontSize: 8 }}>*</span></label><input value={subject} onChange={e => setSubject(e.target.value)} placeholder="Brief summary" style={inp} /></div>
        <div style={{ marginBottom: 10 }}><label style={lbl}>Message <span style={{ color: T.red, fontSize: 8 }}>*</span></label><textarea value={msg} onChange={e => setMsg(e.target.value)} placeholder="Describe in detail..." rows={4} style={{ ...inp, height: "auto", padding: "10px", resize: "vertical", lineHeight: 1.5 }} /></div>

        <div style={{ fontSize: 10, color: T.t3, marginBottom: 10, padding: "6px 8px", background: T.inp, borderRadius: 6, lineHeight: 1.6 }}>
          Auto-attached: app version, device info, timestamp{profile.name ? ", profile (" + profile.name + ")" : ""}
        </div>

        <button onClick={doSend} disabled={!canSend} style={{ width: "100%", padding: 12, fontSize: 14, fontWeight: 700, background: canSend ? T.btnGrad : T.inpBorder, color: "#fff", border: "none", borderRadius: 10, cursor: canSend ? "pointer" : "not-allowed" }}>Submit Feedback</button>
      </>}
    </div>

    {/* History */}
    {history.length > 0 && <div style={{ background: T.card, borderRadius: 12, border: "1px solid " + T.border, boxShadow: T.shadow, marginBottom: 8 }}>
      <button onClick={() => setShowHist(!showHist)} style={{ width: "100%", display: "flex", alignItems: "center", padding: "11px 12px", background: "transparent", border: "none", cursor: "pointer", textAlign: "left" }}>
        <span style={{ flex: 1, fontSize: 14, fontWeight: 700, color: T.t1 }}>Previous Feedback ({history.length})</span>
        <svg width="16" height="16" viewBox="0 0 16 16" style={{ transform: showHist ? "rotate(0)" : "rotate(-90deg)", transition: "transform .2s", color: T.t3 }}><path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" /></svg>
      </button>
      {showHist && <div style={{ padding: "0 12px 12px" }}>
        {history.map((h, i) => {
          const d = new Date(h.timestamp); return <div key={i} style={{ padding: "8px 10px", marginBottom: 6, background: T.inp, borderRadius: 8, border: "1px solid " + T.border }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: h.type === "Bug Report" ? T.red : h.type === "Feature Request" ? T.green : T.accent }}>{h.type}</span>
              <span style={{ fontSize: 9, color: T.t3 }}>{d.toLocaleDateString()} {d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            </div>
            <div style={{ fontSize: 12, fontWeight: 600, color: T.t1, marginBottom: 2 }}>{h.subject}</div>
            <div style={{ fontSize: 11, color: T.t2, lineHeight: 1.5 }}>{h.message.length > 80 ? h.message.slice(0, 80) + "..." : h.message}</div>
          </div>
        })}
      </div>}
    </div>}
  </div>;
}


// ━━━ Onboarding ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function Onboarding({ T, onDone }) {
  const COUNTRIES = ["Afghanistan", "Albania", "Algeria", "Andorra", "Angola", "Argentina", "Armenia", "Australia", "Austria", "Azerbaijan", "Bahamas", "Bahrain", "Bangladesh", "Barbados", "Belarus", "Belgium", "Belize", "Benin", "Bhutan", "Bolivia", "Bosnia and Herzegovina", "Botswana", "Brazil", "Brunei", "Bulgaria", "Burkina Faso", "Burundi", "Cabo Verde", "Cambodia", "Cameroon", "Canada", "Central African Republic", "Chad", "Chile", "China", "Colombia", "Comoros", "Congo", "Costa Rica", "Croatia", "Cuba", "Cyprus", "Czech Republic", "Denmark", "Djibouti", "Dominica", "Dominican Republic", "Ecuador", "Egypt", "El Salvador", "Equatorial Guinea", "Eritrea", "Estonia", "Eswatini", "Ethiopia", "Fiji", "Finland", "France", "Gabon", "Gambia", "Georgia", "Germany", "Ghana", "Greece", "Grenada", "Guatemala", "Guinea", "Guinea-Bissau", "Guyana", "Haiti", "Honduras", "Hungary", "Iceland", "India", "Indonesia", "Iran", "Iraq", "Ireland", "Israel", "Italy", "Jamaica", "Japan", "Jordan", "Kazakhstan", "Kenya", "Korea South", "Kuwait", "Kyrgyzstan", "Laos", "Latvia", "Lebanon", "Lesotho", "Liberia", "Libya", "Lithuania", "Luxembourg", "Madagascar", "Malawi", "Malaysia", "Maldives", "Mali", "Malta", "Mauritania", "Mauritius", "Mexico", "Moldova", "Mongolia", "Montenegro", "Morocco", "Mozambique", "Myanmar", "Namibia", "Nepal", "Netherlands", "New Zealand", "Nicaragua", "Niger", "Nigeria", "North Macedonia", "Norway", "Oman", "Pakistan", "Palestine", "Panama", "Papua New Guinea", "Paraguay", "Peru", "Philippines", "Poland", "Portugal", "Qatar", "Romania", "Russia", "Rwanda", "Saudi Arabia", "Senegal", "Serbia", "Seychelles", "Sierra Leone", "Singapore", "Slovakia", "Slovenia", "Somalia", "South Africa", "South Sudan", "Spain", "Sri Lanka", "Sudan", "Suriname", "Sweden", "Switzerland", "Syria", "Taiwan", "Tajikistan", "Tanzania", "Thailand", "Togo", "Trinidad and Tobago", "Tunisia", "Turkey", "Turkmenistan", "Uganda", "Ukraine", "United Arab Emirates", "United Kingdom", "United States", "Uruguay", "Uzbekistan", "Venezuela", "Vietnam", "Yemen", "Zambia", "Zimbabwe"];
  const DESIG = ["Junior Resident / PG", "Senior Resident / DM Resident", "Faculty", "Nurse", "Others"];
  const UNITS = ["NICU", "PICU", "Pediatric Surgery ICU", "Children Ward", "Others"];
  const [f, setF] = useState({ name: "", sex: "", email: "", mobile: "", designation: "", unit: "NICU", hospital: "", city: "", country: "India" });
  const [cq, setCq] = useState(""); const [cOpen, setCOpen] = useState(false);
  const [step, setStep] = useState(1);
  const [loginMode, setLoginMode] = useState(false);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginStatus, setLoginStatus] = useState("idle");
  const s = k => v => setF(p => ({ ...p, [k]: v }));
  const inp = { width: "100%", height: 42, padding: "0 12px", fontSize: 14, fontWeight: 600, background: T.inp, border: "1.5px solid " + T.inpBorder, borderRadius: 10, color: T.t1, outline: "none", fontFamily: "inherit", boxSizing: "border-box" };
  const sel = { ...inp, cursor: "pointer", WebkitAppearance: "none", appearance: "none", backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23999'/%3E%3C/svg%3E\")", backgroundRepeat: "no-repeat", backgroundPosition: "right 10px center" };
  const lbl = { fontSize: 11, color: T.t3, fontWeight: 600, textTransform: "uppercase", display: "block", marginBottom: 5 };
  const filteredCountries = cq.length > 0 ? COUNTRIES.filter(c => c.toLowerCase().startsWith(cq.toLowerCase())).slice(0, 6) : [];
  const canStep1 = f.name.trim() && f.email.includes("@");
  const canStep2 = f.hospital.trim() && f.city.trim();
  const loginValid = loginEmail.includes("@") && loginEmail.includes(".");

  const doSave = async () => {
    await storeSet("user_profile", JSON.stringify(f));
    supabaseUpsertProfile(f);
    onDone(f);
  };

  const doEmailLogin = async () => {
    if (!loginValid) return;
    setLoginStatus("loading");
    try {
      const profile = await supabaseLoginByEmail(loginEmail.trim().toLowerCase());
      if (profile && profile.name && profile.email) {
        await storeSet("user_profile", JSON.stringify(profile));
        supabaseUpsertProfile(profile); // re-link this device
        onDone(profile);
      } else {
        setLoginStatus("notfound");
      }
    } catch {
      setLoginStatus("error");
    }
  };

  return <div style={{ minHeight: "100vh", background: T.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 20 }}>
    <div style={{ width: "100%", maxWidth: 380 }}>
      <div style={{ textAlign: "center", marginBottom: 24 }}>
        <Logo T={T} width={200} />
        {loginMode
          ? <><h1 style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 700, color: T.t1 }}>Welcome back!</h1><p style={{ margin: 0, fontSize: 13, color: T.t3 }}>Enter your registered email to continue</p></>
          : <><h1 style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 700, color: T.t1 }}>Welcome!</h1><p style={{ margin: 0, fontSize: 13, color: T.t3 }}>Set up your profile to get started</p></>}
      </div>

      {!loginMode && <>
        <div style={{ display: "flex", gap: 6, marginBottom: 20 }}>
          {[1, 2].map(i => <div key={i} style={{ flex: 1, height: 4, borderRadius: 2, background: step >= i ? T.accent : T.inpBorder, transition: "background .3s" }} />)}
        </div>
        <div style={{ background: T.card, borderRadius: 14, padding: 20, border: "1px solid " + T.border, boxShadow: T.shadow }}>
          {step === 1 && <>
            <div style={{ fontSize: 15, fontWeight: 700, color: T.t1, marginBottom: 14 }}>About You</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, marginBottom: 12 }}>
              <div><label style={lbl}>Name <span style={{ color: T.red }}>*</span></label><input value={f.name} onChange={e => s("name")(e.target.value)} placeholder="Full name" style={inp} /></div>
              <div style={{ width: 100 }}><label style={lbl}>Sex</label><select value={f.sex} onChange={e => s("sex")(e.target.value)} style={sel}><option value="">Select</option><option value="Male">Male</option><option value="Female">Female</option></select></div>
            </div>
            <div style={{ marginBottom: 12 }}><label style={lbl}>Email <span style={{ color: T.red }}>*</span></label><input type="email" value={f.email} onChange={e => s("email")(e.target.value)} placeholder="your@email.com" style={{ ...inp, borderColor: f.email && !f.email.includes("@") ? T.red + "66" : T.inpBorder }} /></div>
            <div style={{ marginBottom: 12 }}><label style={lbl}>Mobile <span style={{ fontSize: 9, color: T.t3, fontWeight: 400 }}>(optional)</span></label><input type="tel" value={f.mobile} onChange={e => s("mobile")(e.target.value.replace(/[^\d+\- ]/g, ""))} placeholder="+91..." style={inp} /></div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
              <div><label style={lbl}>Designation</label><select value={f.designation} onChange={e => s("designation")(e.target.value)} style={sel}><option value="">Select...</option>{DESIG.map(d => <option key={d} value={d}>{d}</option>)}</select></div>
              <div><label style={lbl}>Unit</label><select value={f.unit} onChange={e => s("unit")(e.target.value)} style={sel}>{UNITS.map(u => <option key={u} value={u}>{u}</option>)}</select></div>
            </div>
            <button onClick={() => setStep(2)} disabled={!canStep1} style={{ width: "100%", padding: 14, fontSize: 15, fontWeight: 700, background: canStep1 ? T.btnGrad : T.inpBorder, color: "#fff", border: "none", borderRadius: 10, cursor: canStep1 ? "pointer" : "not-allowed" }}>Next</button>
          </>}
          {step === 2 && <>
            <div style={{ fontSize: 15, fontWeight: 700, color: T.t1, marginBottom: 14 }}>Your Workplace</div>
            <div style={{ marginBottom: 12 }}><label style={lbl}>Hospital <span style={{ color: T.red }}>*</span></label><input value={f.hospital} onChange={e => s("hospital")(e.target.value)} placeholder="Hospital name" style={inp} /></div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
              <div><label style={lbl}>City <span style={{ color: T.red }}>*</span></label><input value={f.city} onChange={e => s("city")(e.target.value)} placeholder="City" style={inp} /></div>
              <div style={{ position: "relative" }}><label style={lbl}>Country</label><input value={cOpen ? cq : f.country} onChange={e => { setCq(e.target.value); setCOpen(true); if (!e.target.value) s("country")("") }} onFocus={() => { setCq(""); setCOpen(true) }} onBlur={() => setTimeout(() => setCOpen(false), 150)} placeholder="Type..." style={inp} />
                {cOpen && filteredCountries.length > 0 && <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 50, background: T.card, border: "1.5px solid " + T.accent + "44", borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,.15)", maxHeight: 160, overflowY: "auto", marginTop: 2 }}>
                  {filteredCountries.map(c => <div key={c} onMouseDown={() => { s("country")(c); setCq(c); setCOpen(false) }} style={{ padding: "8px 10px", fontSize: 12, color: T.t1, cursor: "pointer", borderBottom: "1px solid " + T.border + "44" }} onMouseEnter={e => e.currentTarget.style.background = T.accentDim} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>{c}</div>)}
                </div>}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setStep(1)} style={{ padding: "14px 20px", fontSize: 14, fontWeight: 600, background: T.card, color: T.t2, border: "1px solid " + T.border, borderRadius: 10, cursor: "pointer" }}>Back</button>
              <button onClick={doSave} disabled={!canStep2} style={{ flex: 1, padding: 14, fontSize: 15, fontWeight: 700, background: canStep2 ? T.btnGrad : T.inpBorder, color: "#fff", border: "none", borderRadius: 10, cursor: canStep2 ? "pointer" : "not-allowed" }}>Get Started</button>
            </div>
          </>}
        </div>
        <div style={{ textAlign: "center", marginTop: 18 }}>
          <button onClick={() => { setLoginMode(true); setLoginStatus("idle"); setLoginEmail(""); }} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 13, color: T.accent, fontWeight: 600, textDecoration: "underline", fontFamily: "inherit", padding: 4 }}>
            Already registered? Login here
          </button>
        </div>
      </>}

      {loginMode && <div style={{ background: T.card, borderRadius: 14, padding: 24, border: "1px solid " + T.border, boxShadow: T.shadow }}>
        <div style={{ textAlign: "center", marginBottom: 20 }}>
          <div style={{ width: 56, height: 56, borderRadius: "50%", background: T.accentDim, display: "inline-flex", alignItems: "center", justifyContent: "center", marginBottom: 12 }}>
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke={T.accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" /><polyline points="22,6 12,13 2,6" /></svg>
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.t1, marginBottom: 4 }}>Quick Login</div>
          <div style={{ fontSize: 12, color: T.t3 }}>We'll fetch your saved profile instantly</div>
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={lbl}>Registered Email <span style={{ color: T.red }}>*</span></label>
          <input type="email" value={loginEmail} onChange={e => { setLoginEmail(e.target.value); setLoginStatus("idle"); }} onKeyDown={e => { if (e.key === "Enter" && loginValid && loginStatus !== "loading") doEmailLogin(); }} placeholder="your@email.com" autoFocus style={{ ...inp, borderColor: loginStatus === "notfound" || loginStatus === "error" ? T.red + "99" : T.inpBorder }} />
        </div>
        {loginStatus === "notfound" && <div style={{ marginBottom: 14, padding: "10px 12px", background: T.red + "15", border: "1px solid " + T.red + "44", borderRadius: 8, fontSize: 12, color: T.red, fontWeight: 600 }}>
          No profile found for this email. Please check the email or create a new profile below.
        </div>}
        {loginStatus === "error" && <div style={{ marginBottom: 14, padding: "10px 12px", background: T.red + "15", border: "1px solid " + T.red + "44", borderRadius: 8, fontSize: 12, color: T.red, fontWeight: 600 }}>
          Could not connect. Please check your internet and try again.
        </div>}
        <button onClick={doEmailLogin} disabled={!loginValid || loginStatus === "loading"} style={{ width: "100%", padding: 14, fontSize: 15, fontWeight: 700, background: loginValid && loginStatus !== "loading" ? T.btnGrad : T.inpBorder, color: "#fff", border: "none", borderRadius: 10, cursor: loginValid && loginStatus !== "loading" ? "pointer" : "not-allowed", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
          {loginStatus === "loading" ? <><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.8)" strokeWidth="2.5" style={{ animation: "spin 1s linear infinite" }}><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" /></svg> Looking up profile…</> : "Login →"}
        </button>
        <div style={{ textAlign: "center", marginTop: 16 }}>
          <button onClick={() => { setLoginMode(false); setLoginStatus("idle"); }} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, color: T.t3, fontWeight: 600, fontFamily: "inherit", padding: 4 }}>
            ← New here? Create a profile
          </button>
        </div>
      </div>}
    </div>
    <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
  </div>;
}


// ━━━ MAIN ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export default function App() {
  const [theme, setTheme] = useState("classic");
  const [tab, setTab] = useState("tpn");
  const [menuPage, setMenuPage] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [defaults, saveDefaults, loaded] = useStore("tpn_defaults", { ...FACTORY });
  const [nutOv, saveNutOv, nutLoaded] = useStore("nutrition_db", null);
  const [profile, saveProfile, profLoaded] = useStore("user_profile", null);
  const [onboarded, setOnboarded] = useState(false);
  const [supaChecked, setSupaChecked] = useState(false);

  // Try loading profile from Supabase if not found locally (non-blocking with timeout)
  useEffect(() => {
    if (!profLoaded || supaChecked) return;
    const profileOk = profile && profile.name && profile.email && profile.email.includes("@") && profile.hospital && profile.city;
    if (!profileOk) {
      const timeout = new Promise((_, reject) => setTimeout(() => reject("timeout"), 4000));
      Promise.race([supabaseLoadProfile(), timeout]).then(sp => {
        if (sp && sp.name && sp.email) saveProfile(sp);
      }).catch(() => { }).finally(() => setSupaChecked(true));
    } else { setSupaChecked(true); }
  }, [profLoaded, profile, supaChecked, saveProfile]);
  const T = TH[theme];
  const activePage = menuPage || tab;
  const titles = { tpn: "30 sec TPN Calculator", gir: "GIR Dextrose Calculator", nutrition: "Nutrition Audit", profile: "Profile", settings: "Settings", contact: "Contact Us", about: "About", privacy: "Privacy & Disclaimer", faq: "FAQs" };
  if (!loaded || !profLoaded || !nutLoaded || !supaChecked) return <div style={{ minHeight: "100vh", background: TH.classic.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "sans-serif", color: TH.classic.t3 }}>Loading...</div>;

  const profileOk = profile && profile.name && profile.email && profile.email.includes("@") && profile.hospital && profile.city;
  if (!profileOk && !onboarded) return <Onboarding T={T} onDone={p => { saveProfile(p); setOnboarded(true) }} />;
  return <div style={{ minHeight: "100vh", background: T.bg, fontFamily: "'SF Pro Display',-apple-system,'Segoe UI',sans-serif", color: T.t1, maxWidth: 480, margin: "0 auto", paddingBottom: 72, transition: "background .3s" }}>
    <HMenu open={menuOpen} onClose={() => setMenuOpen(false)} onNav={p => { setMenuPage(p); setTab(null) }} T={T} />
    <div className="no-print" style={{ position: "sticky", top: 0, zIndex: 100, background: T.bg, padding: "10px 12px", borderBottom: "1px solid " + T.border, display: "flex", alignItems: "center", gap: 8 }}>
      <button onClick={() => setMenuOpen(true)} style={{ width: 32, height: 32, borderRadius: 8, background: T.card, border: "1px solid " + T.border, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3, flexShrink: 0, padding: 0 }}>{[0, 1, 2].map(i => <div key={i} style={{ width: 14, height: 1.5, background: T.t2, borderRadius: 1 }} />)}</button>
      <div style={{ flex: 1 }}><Logo T={T} width={100} compact /><div style={{ fontSize: 10, color: T.t3, marginTop: -2 }}>{titles[activePage]}</div></div>
      <div style={{ display: "flex", background: T.inp, borderRadius: 8, border: "1px solid " + T.border, padding: 2, gap: 1, flexShrink: 0 }}>
        {[["light", "\u2600\ufe0f"], ["classic", "\ud83c\udf3f"], ["dark", "\ud83c\udf19"]].map(([k, em]) => (
          <button key={k} onClick={() => setTheme(k)} style={{ width: 30, height: 26, borderRadius: 6, border: "none", cursor: "pointer", fontSize: 13, background: theme === k ? T.accentDim : "transparent", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}>{em}</button>
        ))}
      </div>
    </div>
    <div style={{ padding: "8px 8px" }}>
      {activePage === "tpn" && <TPNPage T={T} defaults={defaults} />}
      {activePage === "gir" && <GIRPage T={T} />}
      {activePage === "nutrition" && <NutritionPage T={T} defaults={defaults} nutOv={nutOv} saveNutOv={saveNutOv} />}
      {activePage === "settings" && <SettingsPage T={T} defaults={defaults} saveDefaults={saveDefaults} />}
      {activePage === "profile" && <ProfilePage T={T} />}
      {activePage === "about" && <AboutPage T={T} />}
      {activePage === "privacy" && <PrivacyPage T={T} />}
      {activePage === "faq" && <FAQPage T={T} />}
      {activePage === "contact" && <ContactPage T={T} />}
    </div>
    <div className="no-print" style={{ position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)", width: "100%", maxWidth: 480, background: T.navBg, borderTop: "1px solid " + T.navBorder, display: "flex", zIndex: 100, boxShadow: "0 -2px 12px rgba(0,0,0,.08)" }}>
      {[["tpn", ICO_TPN, "30 sec TPN"], ["gir", ICO_GIR, "GIR"], ["nutrition", ICO_NUT, "Nutrition Audit"]].map(([id, ico, lb]) => { const on = tab === id && !menuPage; return <button key={id} onClick={() => { setTab(id); setMenuPage(null) }} style={{ flex: 1, padding: "6px 0 5px", background: "transparent", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 2, opacity: on ? 1 : .45 }}><img src={ico} alt={lb} style={{ width: 28, height: 28, objectFit: "contain" }} /><span style={{ fontSize: 10, fontWeight: on ? 700 : 500, color: on ? T.accentText : T.t3 }}>{lb}</span>{on && <div style={{ width: 20, height: 2, borderRadius: 1, background: T.accent, marginTop: 1 }} />}</button> })}
    </div>
    <style>{`@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}@keyframes slideIn{from{transform:translateX(-100%)}to{transform:translateX(0)}}input[type=number]::-webkit-outer-spin-button,input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}input[type=number]{-moz-appearance:textfield}input[type=date]{-webkit-appearance:none}*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}@media print{.no-print{display:none!important}body{background:#fff!important}.syr-card{break-inside:avoid}}`}</style>
  </div>;
}
