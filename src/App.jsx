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
  const img = <img src={T === TH.dark ? LOGO_DARK : LOGO_LIGHT} alt="NeoFORT" style={{ width, height: "auto", display: "block" }} />;
  if (!compact) return img;
  return <div style={{ width, height: Math.round(width * LOGO_AR * LOGO_CLIP), overflow: "hidden" }}>{img}</div>;
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
      <div style={{ padding: "12px 20px", borderTop: "1px solid " + T.border, fontSize: 10, color: T.t3 }}>NeoFORT v1.0</div>
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
      <div style={{ fontSize: 13, color: T.t3, marginTop: 8 }}>v1.0</div>
    </div>

    <div style={card}>
      <div style={{ fontSize: 15, fontWeight: 700, color: T.accentText, marginBottom: 10 }}>About NeoFORT</div>
      <p style={{ fontSize: 14, color: T.t2, lineHeight: 1.8, margin: "0 0 12px" }}>NeoFORT (Neonatal Fluid Optimisation & Review Tool) is a clinician-designed digital platform developed to support evidence-based neonatal nutrition and bedside decision-making in NICU settings.</p>
      <p style={{ fontSize: 14, color: T.t2, lineHeight: 1.8, margin: "0 0 8px" }}>Version 1.0 currently includes:</p>
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
      appVersion: "NeoFORT v1.0",
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
          device_id: getDeviceId(), device: entry.device, browser: entry.browser, screen: entry.screen, app_version: "NeoFORT v1.0"
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
