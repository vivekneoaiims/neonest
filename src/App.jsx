import { useState, useCallback, useMemo, useRef, useEffect } from "react";

// ━━━ Supabase Proxy Config ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// All Supabase calls go through /api/profile (Vercel serverless function)
// This bypasses India ISP blocks and keeps the Supabase key server-side

function getDeviceId() {
  const KEY = "neonest_device_id";
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

// ━━━ Calculation Engine ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function calculateTPN(inputs) {
  const {
    weightG, tfr, feeds, ivm, aminoAcid, lipid, gir,
    sodium, potassium, calcium, magnesium, po4,
    ivmN5, ivmN2, ivmNS, ivmDex10,
    feedType, prenanStrength, naSource, aaSource,
    caViaTPN, po4ViaTPN, use5Dex, use25Dex, overfill, celcel, mvi, syringeCount,
    ebmCal100, formulaCal100, ebmProt100, formulaProt100, hmfCalPerG, hmfProtPerG
  } = inputs;
  const wt = weightG / 1000;

  const errors = [];
  if (wt <= 0) errors.push("Weight must be greater than 0.");
  if (feedType === "NPO" && feeds > 0) errors.push("Feed type is NPO but feeds entered as " + feeds + " mL/kg/d. Set feeds to 0 or change feed type.");
  if (feeds > tfr) errors.push("Feeds (" + feeds + " mL/kg/d) exceed total fluid rate (" + tfr + " mL/kg/d). Reduce feeds or increase TFR.");
  const ivmSum = ivmN5 + ivmN2 + ivmNS + ivmDex10;
  if (ivm > 0 && ivmSum > ivm) errors.push("IVM breakdown total (" + ivmSum + " mL) exceeds IVM volume (" + ivm + " mL). Correct IVM breakdown or increase IVM.");
  if (ivm === 0 && ivmSum > 0) errors.push("IVM is 0 but sub-volumes total " + ivmSum + " mL. Enter IVM volume or clear breakdown fields.");

  if (wt <= 0) return { errors };

  const I13 = naSource, I14 = aaSource, I12 = caViaTPN ? 1 : 0;
  const F13 = use5Dex ? 1 : 0, F15 = use25Dex ? 1 : 0, F14 = use5Dex ? 0 : 1;
  const I15 = overfill, I16 = celcel, I17 = mvi;

  const naInIVM = ((ivmN5 * 0.031) + (ivmN2 * 0.077) + (ivmNS * 0.154)) / wt;
  const glcInIVM = ivmDex10 * 0.1;
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
  if (dexHighVol < -0.05) errors.push(dexHighName + " volume is negative (" + r1(dexHighVol) + " mL). Try different dextrose concentrations or reduce GIR.");

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
const LOGO_DARK = "data:image/png;base64,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ee8VM44+6QbbioaULyG55QRV0ovGukoVbgjD5qyWVpqS3BRtCqqainLsCQTSkr1tLvn7A6/a159zAt19zcQXAbUeABoD9oS1WzYWfvblXO/pxXdcYhjOioamgHr5zVn2wF5d/TUvz/MP6NsJg4eO/BnAIK21mLZ4sQSgu3frddnPK7ZkvvP2jBPOOOukE+qiSv/0/gv4+fsfxKWP/g1vvv7KjNHHn+742zVnP3LdjQ/I888/5fE2qQlY/m4pvvhyPl575u8wHaHHAZjRqNbh3TVqy6Yd9oiJY/8R144hpERZWZnn9jtY2dVVqnpHdf3xkwrvbj47mZlKS0vFiiVvP3jqhPPO3LhjU+e/XFySf+KE8V8Y7k6Y8tibeP+LuXjykTsQaah86JFHXtk1ecqznvq6napyTyatqI68l92x/Msbr5k097bbHqW+T5c899prrw294IILqgEIxRRpqNwaUXR4AsaXkszhxkYVrK2EE5Kb4SLV63+88bxTRo//xzNvtrnhb09mn37ycV8IkYT5U9/HjK/n49l//A25qY6H+gy/cObaTesffvjOy5669e//cJ160vjb22R3vr18fSOmPHMLElIzMOnYPo0brbJnQhvFZayF+viDWXaiQeeHI3x+sLEGY8f0xoiRQ/DwU68jFF5487iRAzH9882B555/E38tGitr68orYvMC/VYhs48G0/zLQGNt4p1XnCuzUtLrtlZWWlLKyM3n//X0Mb3a1j9+51+NhkCtCwBWrlrJlxYVyDNG93EazMhKTkKWR8IFhSRfarvxw0e94QpsvfzlF+5cw9rCL4tXYd26bRg5sCduvvKUOdGdW8Z+8PYHMcatq/PcduVZMjHJ61y2bBkzs3jq0WdPPnlIhxUvPXOFTE8RvkDYujwt3WH+/bozxNKynyZ36tTzEZ/D80hO1+7XTDp+sDjh2GHC5fGc8s9//jN1x86dgaITC+QFk46RTQgpAMbuPdWnHF84RA7rkVspyXOD4Uh5hIgeeemNVx576t6rZMdOmWC3505th3P+fu0k2bNDjvQYhPTMJHgSPVi2ZEnneDSgZcP+uHqVykr20t9vPEemZybC5XPDl+BCss+DrJRs461X3343Py95/hknHWXPX7AYMz5bYOakJZvPP3rjrkhdzVWJbRJGjhvYceOg/I74ds73mPPdQlfhiP7mXbcWr/ll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";
const ICO_TPN = "data:image/png;base64,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";
const ICO_GIR = "data:image/png;base64,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";
const ICO_NUT = "data:image/png;base64,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";
const LOGO_LIGHT_C = "data:image/png;base64,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";
const LOGO_DARK_C = "data:image/png;base64,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";
function Logo({ T, width = 200, compact = false }) {
  const src = compact ? (T === TH.dark ? LOGO_DARK_C : LOGO_LIGHT_C) : (T === TH.dark ? LOGO_DARK : LOGO_LIGHT);
  return <img src={src} alt="NeoNEST" style={{ width, height: "auto" }} />;
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
  ivmBreak: "Break down total IVM volume by fluid type so calculator subtracts Na & glucose already going via IV medications.\nN/5 = 0.2% NS, N/2 = 0.45% NS, NS = 0.9% NaCl.",
  aaSource: "Aminoven: Pure amino acids.\nPentamin: Contains 8.7 mEq Na + 1.5 mEq K per 100 mL - calculator auto-adjusts Na/K.",
  naSource: "3% NaCl: Standard (0.51 mEq Na/mL).\nCRL (Conc. Ringer Lactate): Alternative, ~1.5 mEq Na/mL.",
  dex: "Dextrose concentrations for mixing.\n10% + 50% is most common.\nUse 5% + 25% for lower GIR needs.",
  caInTPN: "ON: Ca Gluconate added to Syringe 2.\nOFF: 10% Ca Gluconate given as separate infusion.",
  po4InTPN: "ON: Potassium Phosphate (KPO4) added to Syringe 2.\nOFF: KPO4 given as separate infusion.\nDefault: OFF (separate).",
  celcel: "Celcel (trace elements): Usual 1 mL/kg/day.\nAdd after 2 weeks of age.\nAvoid in cholestasis.",
  mviHelp: "MVI (Multivitamin injection): Usual 1 mL/kg/day.\nAdded to Syringe 1 (lipid syringe).",
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
  const inc = () => { const n = +(value + step).toFixed(4); onChange(max != null ? Math.min(n, max) : n) };
  const dec = () => onChange(Math.max(+(value - step).toFixed(4), min));
  return <div style={{ flex: "1 1 0", minWidth: 0 }}>
    <div style={{ display: "flex", alignItems: "baseline", marginBottom: 3, minHeight: 15, gap: 3 }}>
      <label style={{ fontSize: 10, color: T.t3, fontWeight: 600, letterSpacing: ".03em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flexShrink: 1, minWidth: 0 }}>{label}</label>
      {unit && <span style={{ fontSize: 8.5, color: T.t3, fontWeight: 400, opacity: 0.75, whiteSpace: "nowrap", flexShrink: 0 }}>({unit})</span>}
      {info && <InfoBtn id={info} T={T} oi={oi} soi={soi} />}
    </div>
    <div style={{ display: "flex", alignItems: "center", background: T.inp, borderRadius: 8, border: "1.5px solid " + T.inpBorder, height: 38, overflow: "hidden" }}>
      <input type="number" value={value} onChange={e => onChange(parseFloat(e.target.value) || 0)} step={step} min={min} max={max}
        style={{ width: 0, flex: "1 1 auto", padding: "0 4px 0 6px", fontSize: 15, fontWeight: 700, background: "transparent", border: "none", color: T.t1, outline: "none", fontFamily: "'JetBrains Mono',monospace", minWidth: 0 }}
        onFocus={e => { e.currentTarget.parentElement.style.borderColor = T.inpFocus; e.currentTarget.select(); }} onBlur={e => e.currentTarget.parentElement.style.borderColor = T.inpBorder} />
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
const FACTORY = { weightG: 1000, tfr: 100, feeds: 0, ivm: 0, aminoAcid: 3, lipid: 3, gir: 6, sodium: 3, potassium: 2, calcium: 0, magnesium: 0, po4: 0, ivmN5: 0, ivmN2: 0, ivmNS: 0, ivmDex10: 0, feedType: "NPO", prenanStrength: "None", naSource: "3% NaCl", aaSource: "Aminoven", caViaTPN: true, po4ViaTPN: false, use5Dex: false, use25Dex: false, overfill: 1, celcel: 0, mvi: 1, syringeCount: 2, ebmCal100: 67, formulaCal100: 78, ebmProt100: 1.1, formulaProt100: 1.9, hmfCalPerG: 4, hmfProtPerG: 0.3 };
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
      <div style={{ padding: "12px 20px", borderTop: "1px solid " + T.border, fontSize: 10, color: T.t3 }}>NeoNEST v1.0</div>
    </div></>;
}

// ━━━ TPN Page ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
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
      <Row><NI label="Feeds" unit="mL/kg/d" value={ip.feeds} onChange={s("feeds")} step={5} T={T} info="feeds" oi={oi} soi={soi} /><NI label="IVM" unit="mL" value={ip.ivm} onChange={s("ivm")} step={1} T={T} info="ivm" oi={oi} soi={soi} /></Row>
      <Row><Pills label="Feed type" value={ip.feedType} options={["NPO", "EBM/PDHM", "Formula"]} onChange={s("feedType")} T={T} info="feedType" oi={oi} soi={soi} />{ip.feedType !== "NPO" && ip.feedType !== "Formula" ? <Pills label={fortLabel + " strength"} value={ip.prenanStrength} options={["None", "Quarter", "Half", "Full"]} onChange={s("prenanStrength")} T={T} info="hmf" oi={oi} soi={soi} /> : <div style={{ flex: "1 1 0" }} />}</Row>
    </Sec>

    <Sec title="Nutrition Targets" open={sec.nut} onToggle={() => t("nut")} T={T}>
      <Row><NI label="Amino acids (A)" unit="g/kg/d" value={ip.aminoAcid} onChange={s("aminoAcid")} step={.25} T={T} info="aminoAcid" oi={oi} soi={soi} /><NI label="Lipids (L)" unit="g/kg/d" value={ip.lipid} onChange={s("lipid")} step={.25} T={T} info="lipid" oi={oi} soi={soi} /><NI label="GIR (G)" unit="mg/kg/min" value={ip.gir} onChange={s("gir")} step={.5} T={T} info="gir" oi={oi} soi={soi} /></Row>
    </Sec>

    <Sec title="Electrolytes" open={sec.elec} onToggle={() => t("elec")} T={T}>
      <Row><NI label="Na" unit="mEq/kg/d" value={ip.sodium} onChange={s("sodium")} step={.5} T={T} info="na" oi={oi} soi={soi} /><NI label="K" unit="mEq/kg/d" value={ip.potassium} onChange={s("potassium")} step={.5} T={T} info="k" oi={oi} soi={soi} /><NI label="Ca" unit="mg/kg/d" value={ip.calcium} onChange={s("calcium")} step={5} T={T} info="ca" oi={oi} soi={soi} /></Row>
      <Row><NI label="PO4" unit="mg/kg/d" value={ip.po4} onChange={s("po4")} step={5} T={T} info="po4" oi={oi} soi={soi} /><NI label="Mg" unit="mEq/kg/d" value={ip.magnesium} onChange={s("magnesium")} step={.5} T={T} info="mg" oi={oi} soi={soi} /><div style={{ flex: "1 1 0" }} /></Row>
    </Sec>

    <Sec title="IVM Breakdown" open={sec.ivm} onToggle={() => t("ivm")} T={T}>
      <Row><NI label="N/5" unit="mL" value={ip.ivmN5} onChange={s("ivmN5")} step={1} T={T} info="ivmBreak" oi={oi} soi={soi} /><NI label="N/2" unit="mL" value={ip.ivmN2} onChange={s("ivmN2")} step={1} T={T} /><NI label="NS" unit="mL" value={ip.ivmNS} onChange={s("ivmNS")} step={1} T={T} /><NI label="10% Dex" unit="mL" value={ip.ivmDex10} onChange={s("ivmDex10")} step={1} T={T} /></Row>
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
        <button onClick={() => window.print()} style={{ flex: 1, padding: 12, fontSize: 13, fontWeight: 700, background: T.card, color: T.t2, border: "1.5px solid " + T.border, borderRadius: 10, cursor: "pointer" }}>🖨️ Print</button>
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
const NUTRIENTS = [
  { k: "energy", n: "Energy", u: "kcal/kg", bm: 67, fm: 78, hm: 4, aap: [105, 130], esp: [110, 135] },
  { k: "protein", n: "Protein", u: "g/kg", bm: 1.1, fm: 1.9, hm: 0.3, aap: [3.5, 4.0], esp: [3.5, 4.0] },
  { k: "fat", n: "Fat", u: "g/kg", bm: 3.6, fm: 3.8, hm: 0.1, aap: [5.0, 7.0], esp: [4.8, 6.6] },
  { k: "carb", n: "Carbohydrate", u: "g/kg", bm: 6.7, fm: 8.1, hm: 0.4, aap: [10.0, 14], esp: [11.6, 13.2] },
  { k: "ca", n: "Calcium", u: "mg/kg/d", bm: 26, fm: 95, hm: 15.93, aap: [200, 210], esp: [120, 140], sup: true },
  { k: "po4", n: "Phosphorus", u: "mg/kg/d", bm: 13, fm: 48, hm: 8.76, aap: [100, 110], esp: [60, 90], sup: true },
  { k: "fe", n: "Iron", u: "mg/kg/d", bm: 0.12, fm: 1.67, hm: 0.36, aap: [2.0, 3.0], esp: [2.0, 3.0], sup: true },
  { k: "vitd", n: "Vitamin D", u: "IU/d", bm: 2, fm: 160, hm: 28, aap: [400, 400], esp: [800, 1000], perDay: true },
  { k: "na", n: "Sodium", u: "mEq/kg/d", bm: 1.4, fm: 1.03, hm: 0.32, aap: [2.0, 3.0], esp: [3.0, 5.0] },
  { k: "k", n: "Potassium", u: "mEq/kg/d", bm: 2.4, fm: 0.74, hm: 0.25, aap: [1.7, 2.5], esp: [3.0, 5.0] },
  { k: "mg", n: "Magnesium", u: "mg/kg/d", bm: 3, fm: 3.7, hm: 0.8, esp: [8.0, 15.0] },
  { k: "zn", n: "Zinc", u: "mg/kg/d", bm: 0.33, fm: 0.28, hm: 0.19, aap: [0.6, 1.0], esp: [1.1, 2.0] },
  { k: "vita", n: "Vitamin A", u: "IU/kg/d", bm: 50, fm: 505, hm: 221.6, aap: [92, 270], esp: [1330, 3300] },
  { k: "vite", n: "Vitamin E", u: "IU/kg/d", bm: 1.5, fm: 1.11, hm: 1.12, aap: [1.3, 1.3], esp: [2.2, 11] },
  { k: "vitk", n: "Vitamin K", u: "mcg/kg/d", bm: 0.2, fm: 6.67, hm: 1.5, aap: [4.8, 4.8], esp: [4.4, 28] },
  { k: "vitc", n: "Vitamin C", u: "mg/kg/d", bm: 10.6, fm: 6.67, hm: 3.75, aap: [42, 42], esp: [11, 46] },
  { k: "folic", n: "Folic acid", u: "mcg/kg/d", bm: 3.3, fm: 16.7, hm: 7.5, aap: [40, 40], esp: [35, 100] },
  { k: "cu", n: "Copper", u: "mcg/kg/d", bm: 73, fm: 35.6, hm: 10, aap: [100, 108], esp: [100, 132] },
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
    let fromHmf = hmfG * nut.hm;
    let fromSup = 0;
    if (nut.k === "ca") fromSup = (ip.caMl * (ip.caConcCa || 0)) + (ip.extraCaMgDay || 0);
    if (nut.k === "fe") fromSup = ip.feMl * ip.feConc;
    if (nut.k === "vitd") fromSup = ip.vitdIU;
    if (nut.k === "po4") fromSup = (ip.caMl * (ip.caConcP || 0)) + (ip.extraPMgDay || 0);
    const totalAbs = fromEbm + fromFm + fromHmf + fromSup;
    const perKg = nut.perDay ? totalAbs : totalAbs / wt;
    const rda = nut.esp;
    let status = "ok";
    if (rda) { if (perKg < rda[0] * 0.95) status = "low"; else if (perKg > rda[1] * 1.05) status = "high" }
    return { ...nut, fromEbm, fromFm, fromHmf, fromSup, totalAbs, perKg, status };
  });
  const eRow = rows.find(r => r.k === "energy"), pRow = rows.find(r => r.k === "protein");
  const pe = eRow && pRow && eRow.perKg > 0 ? (pRow.perKg / eRow.perKg) * 1000 : 0;
  return { rows, feedMlKg, totalFeedMl, ebmMl, fmMl, hmfG, wtGain, pe, wt };
}
function NutDBEditor({ T, nutOv, saveNutOv, onClose, onSupSaved }) {
  const [tab, setTab] = useState("bm");
  const [d, setD] = useState(() => {
    const init = {};
    NUTRIENTS.forEach(nut => {
      const ov = nutOv?.[nut.k] || {};
      init[nut.k] = {
        bm: ov.bm ?? nut.bm, fm: ov.fm ?? nut.fm, hm: ov.hm ?? nut.hm,
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
  }));
  const upd = (k, field, val) => setD(p => ({ ...p, [k]: { ...p[k], [field]: val } }));
  const updRda = (k, field, idx, val) => setD(p => { const arr = [...(p[k][field] || [0, 0])]; arr[idx] = val; return { ...p, [k]: { ...p[k], [field]: arr } }; });
  const tabs = [{ id: "bm", l: "EBM", sub: "per 100 mL" }, { id: "fm", l: "Formula", sub: "per 100 mL" }, { id: "hm", l: "HMF/PTF", sub: "per gram" }, { id: "sup", l: "Suppl.", sub: "defaults" }, { id: "aap", l: "AAP", sub: "RDA range" }, { id: "esp", l: "ESPGHAN", sub: "RDA range" }];
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
          <div style={{ fontSize: 9, color: T.t3, marginTop: 8, padding: "0 4px" }}>These values will be used as default concentrations when starting a new nutrition audit.</div>
        </div>
      </> : <>
        {/* Header */}
        <div style={{ display: "grid", gridTemplateColumns: isRda ? "1fr 64px 64px" : "1fr 80px", gap: 4, padding: "4px 4px 2px", borderBottom: "1px solid " + T.border }}>
          <span style={{ fontSize: 9, fontWeight: 700, color: T.t3 }}>NUTRIENT</span>
          {isRda ? <><span style={{ fontSize: 9, fontWeight: 700, color: T.t3, textAlign: "center" }}>LOW</span><span style={{ fontSize: 9, fontWeight: 700, color: T.t3, textAlign: "center" }}>HIGH</span></> : <span style={{ fontSize: 9, fontWeight: 700, color: T.t3, textAlign: "center" }}>VALUE</span>}
        </div>
        {NUTRIENTS.map(nut => {
          const val = d[nut.k];
          const inpSt = { width: "100%", height: 30, padding: "0 4px", fontSize: 12, fontWeight: 600, background: T.inp, border: "1.5px solid " + T.inpBorder, borderRadius: 6, color: T.t1, outline: "none", fontFamily: "'JetBrains Mono',monospace", boxSizing: "border-box", textAlign: "center" };
          return <div key={nut.k} style={{ display: "grid", gridTemplateColumns: isRda ? "1fr 64px 64px" : "1fr 80px", gap: 4, padding: "5px 4px", borderBottom: "1px solid " + T.border + "44", alignItems: "center" }}>
            <div><div style={{ fontSize: 11, fontWeight: 600, color: T.t1 }}>{nut.n}</div><div style={{ fontSize: 8, color: T.t3 }}>{nut.u}</div></div>
            {isRda ? <>
              <input type="number" value={val[tab][0]} onChange={e => updRda(nut.k, tab, 0, parseFloat(e.target.value) || 0)} onFocus={e => e.target.select()} step={0.1} style={inpSt} />
              <input type="number" value={val[tab][1]} onChange={e => updRda(nut.k, tab, 1, parseFloat(e.target.value) || 0)} onFocus={e => e.target.select()} step={0.1} style={inpSt} />
            </> : <input type="number" value={val[tab]} onChange={e => upd(nut.k, tab, parseFloat(e.target.value) || 0)} onFocus={e => e.target.select()} step={0.01} style={inpSt} />}
          </div>;
        })}
      </>}
    </div>
    <div style={{ display: "flex", gap: 6, padding: "8px 10px", borderTop: "1px solid " + T.border }}>
      <button onClick={() => { saveNutOv({ ...d, __supDef: supDef }); if (onSupSaved) onSupSaved(supDef); alert("Nutrition database saved!") }} style={{ flex: 1, padding: 10, fontSize: 13, fontWeight: 700, background: T.btnGrad, color: "#fff", border: "none", borderRadius: 8, cursor: "pointer" }}>Save Defaults</button>
      <button onClick={() => { saveNutOv(null); const init = {}; NUTRIENTS.forEach(nut => { init[nut.k] = { bm: nut.bm, fm: nut.fm, hm: nut.hm, aap: nut.aap ? [...nut.aap] : [0, 0], esp: nut.esp ? [...nut.esp] : [0, 0] }; }); setD(init); setSupDef({ caConcCa: 16, caConcP: 8, feConc: 10 }); alert("Reset to factory values!") }} style={{ padding: "10px 14px", fontSize: 11, fontWeight: 600, background: T.card, color: T.red, border: "1px solid " + T.red + "33", borderRadius: 8, cursor: "pointer" }}>Reset</button>
    </div>
  </div>;
}
function NutritionPage({ T, defaults, nutOv, saveNutOv }) {
  const [ip, setIp] = useState({
    babyOf: "", patientId: "", date: todayStr(), wtNow: 1500, wtLast: 1400, mode: "day", perFeed: 15, feedsPerDay: 12, totalMlKg: 150,
    feedSrc: "EBM", ebmPct: 70, hmfMode: "day", hmfPerFeed: 0, hmfPerDay: 0, hmfFreq: 12,
    caMl: 0, caConcCa: nutOv?.__supDef?.caConcCa ?? 16, caConcP: nutOv?.__supDef?.caConcP ?? 8, feMl: 0, feConc: nutOv?.__supDef?.feConc ?? 10, extraCaMgDay: 0, extraPMgDay: 0, vitdIU: 400
  });
  const [show, setShow] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const s = k => v => setIp(p => ({ ...p, [k]: v }));
  const nutDB = useMemo(() => mergeNutDB(nutOv), [nutOv]);
  const res = useMemo(() => calcNutrition(ip, nutDB), [ip, nutDB]);
  const fortLabel = (defaults?.hmfProtPerG || 0) < 0.2 ? "PTF" : "HMF";

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
    </Sec>

    <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
      <button onClick={() => setEditing(!editing)} style={{ flex: 1, padding: "10px 12px", fontSize: 12, fontWeight: 600, background: editing ? T.accentDim : T.card, color: editing ? T.accentText : T.t2, border: "1px solid " + (editing ? T.accent + "44" : T.border), borderRadius: 10, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        {editing ? "Close Editor" : "Edit Nutrition Database"}
      </button>
    </div>

    {editing && <NutDBEditor T={T} nutOv={nutOv} saveNutOv={saveNutOv} onClose={() => setEditing(false)} onSupSaved={sd => { if (sd.caConcCa != null) s("caConcCa")(sd.caConcCa); if (sd.caConcP != null) s("caConcP")(sd.caConcP); if (sd.feConc != null) s("feConc")(sd.feConc); }} />}

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
        <Metric label="P:E ratio" val={res.pe.toFixed(1)} unit="" color={T.purple} T={T} warn={res.pe < 2.8 || res.pe > 3.6 ? "mid" : undefined} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 8 }}>
        <Metric label="Feed vol" val={r1(res.feedMlKg).toFixed(0)} unit="mL/kg" color={T.accent} T={T} />
        <Metric label={fortLabel} val={r1(res.hmfG).toFixed(1)} unit="g/d" color={T.green} T={T} />
        <Metric label="Wt gain" val={res.wtGain.toFixed(1)} unit="g/kg/d" color={res.wtGain >= 15 ? T.green : T.amber} T={T} />
      </div>

      {/* Nutrient table */}
      <div style={{ background: T.card, borderRadius: 12, border: "1px solid " + T.border, boxShadow: T.shadow, marginBottom: 8, overflow: "hidden" }}>
        <div style={{ padding: "10px 12px", borderBottom: "1px solid " + T.border }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.t1 }}>Nutrient Audit</div>
          <div style={{ fontSize: 10, color: T.t3 }}>Color-coded vs ESPGHAN RDA</div>
        </div>
        {/* Header */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 58px 48px 58px", gap: 0, padding: "6px 10px", borderBottom: "1px solid " + T.border, background: T.inp }}>
          <span style={{ fontSize: 9, fontWeight: 700, color: T.t3 }}>NUTRIENT</span>
          <span style={{ fontSize: 9, fontWeight: 700, color: T.t3, textAlign: "right" }}>INTAKE</span>
          <span style={{ fontSize: 9, fontWeight: 700, color: T.t3, textAlign: "right" }}>AAP</span>
          <span style={{ fontSize: 9, fontWeight: 700, color: T.t3, textAlign: "right" }}>ESPGHAN</span>
        </div>
        {(expanded ? res.rows : res.rows.slice(0, 8)).map((r, i) => {
          const sc = statusColor(r.status);
          const bg = statusBg(r.status);
          const rdaStr = rda => rda ? (rda[0] === rda[1] ? ">" + rda[0] : rda[0] + "-" + rda[1]) : "-";
          return <div key={r.k} style={{ display: "grid", gridTemplateColumns: "1fr 58px 48px 58px", gap: 0, padding: "7px 10px", borderBottom: i < (expanded ? res.rows.length : 8) - 1 ? "1px solid " + T.border + "44" : "none", alignItems: "center", background: bg }}>
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <div style={{ width: 6, height: 6, borderRadius: 3, background: sc, flexShrink: 0 }} />
              <div><div style={{ fontSize: 11, fontWeight: 600, color: T.t1 }}>{r.n}</div><div style={{ fontSize: 8, color: T.t3 }}>{r.u}</div></div>
            </div>
            <div style={{ textAlign: "right" }}><span style={{ fontSize: 12, fontWeight: 700, color: sc, fontFamily: "'JetBrains Mono',monospace" }}>{r.perKg < 10 ? r.perKg.toFixed(1) : Math.round(r.perKg)}</span></div>
            <div style={{ textAlign: "right", fontSize: 9, color: T.t3 }}>{rdaStr(r.aap)}</div>
            <div style={{ textAlign: "right", fontSize: 9, color: T.t3 }}>{rdaStr(r.esp)}</div>
          </div>;
        })}
        {res.rows.length > 8 && <button onClick={() => setExpanded(!expanded)} style={{ width: "100%", padding: "8px 0", fontSize: 11, fontWeight: 600, color: T.accentText, background: T.accentDim, border: "none", cursor: "pointer" }}>{expanded ? "Show less" : "Show all " + res.rows.length + " nutrients"}</button>}
      </div>

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
        <button onClick={() => window.print()} style={{ flex: 1, padding: 12, fontSize: 13, fontWeight: 700, background: T.card, color: T.t2, border: "1.5px solid " + T.border, borderRadius: 10, cursor: "pointer" }}>🖨️ Print</button>
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
      <div style={{ fontSize: 15, fontWeight: 700, color: T.accentText, marginBottom: 10 }}>About NeoNEST</div>
      <p style={{ fontSize: 14, color: T.t2, lineHeight: 1.8, margin: "0 0 12px" }}>NeoNEST (Neonatal Essential Support Tools) is a clinician-designed digital platform developed to support evidence-based neonatal nutrition and bedside decision-making in NICU settings.</p>
      <p style={{ fontSize: 14, color: T.t2, lineHeight: 1.8, margin: "0 0 8px" }}>Version 1.0 currently includes:</p>
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {["30 sec TPN", "GIR Calculator", "Nutrition Audit"].map((t, i) => <div key={i} style={{ flex: 1, padding: "10px 6px", background: T.accentDim, borderRadius: 8, border: "1px solid " + T.accent + "18", textAlign: "center", fontSize: 12, fontWeight: 600, color: T.accentText }}>{t}</div>)}
      </div>
      <p style={{ fontSize: 14, color: T.t2, lineHeight: 1.8, margin: 0 }}>NeoNEST is designed to reduce calculation errors, save bedside time, and promote structured documentation in neonatal units.</p>
    </div>

    <div style={card}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginBottom: 14 }}>
        <img src="/dev_photo.jpeg" alt="Dr. Vivek Kumar" style={{ width: 120, height: 120, borderRadius: "50%", objectFit: "cover", border: "3px solid " + T.accent + "33", marginBottom: 12 }} />
        <div style={{ fontSize: 15, fontWeight: 700, color: T.accentText }}>About the Developer</div>
      </div>
      <p style={{ fontSize: 14, color: T.t2, lineHeight: 1.8, margin: "0 0 10px" }}>Dr. Vivek Kumar is a neonatologist and currently an Assistant Professor at Lady Hardinge Medical College (LHMC), New Delhi. He completed his medical training (MBBS, MD, and DM) at AIIMS, New Delhi.</p>
      <p style={{ fontSize: 14, color: T.t2, lineHeight: 1.8, margin: 0 }}>NeoNEST is a personal, independent project born from his interest in the application of digital technology and Artificial Intelligence to enhance neonatal care.</p>
    </div>

    <div style={{ ...card, background: T.accentDim, border: "1px solid " + T.accent + "25", padding: "18px 20px" }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: T.accentText, marginBottom: 8, letterSpacing: ".03em", textTransform: "uppercase" }}>A note from the developer</div>
      <p style={{ fontSize: 13, color: T.t2, lineHeight: 1.9, margin: "0 0 8px", fontStyle: "italic" }}>"In neonatal care, small numbers carry great weight. A minor miscalculation can affect a life measured in grams. NeoNEST was first conceptualized during my DM training at AIIMS, New Delhi, where I developed Excel-based calculators that continue to be used in clinical practice at AIIMS and other centers.</p>
      <p style={{ fontSize: 13, color: T.t2, lineHeight: 1.9, margin: "0 0 8px", fontStyle: "italic" }}>Over time, it became clear that thoughtfully designed digital tools could further enhance safety, efficiency, and standardization in the NICU. NeoNEST represents the evolution of that early work into a clinician-friendly application, developed with the assistance of modern digital technologies.</p>
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
      <p style={{ fontSize: 14, color: T.t2, lineHeight: 1.85, margin: 0 }}>NeoNEST does not replace clinical judgment, institutional protocols, or established medical guidelines. It is meant to assist — not to direct — neonatal nutritional management.</p>
    </div>
  </div>;
}
function FAQPage({ T }) {
  const [openIdx, setOpenIdx] = useState(null);
  const toggle = i => setOpenIdx(openIdx === i ? null : i);
  const card = { background: T.card, borderRadius: 12, padding: "18px 18px", border: "1px solid " + T.border, boxShadow: T.shadow, marginBottom: 8 };
  const faqs = [
    { q: "What is NeoNEST?", a: "NeoNEST (Neonatal Essential Support Tools) is a clinician-designed app for NICU teams that helps with TPN calculations, GIR/dextrose calculations, and structured nutrition audits. It was developed by Dr. Vivek Kumar (Assistant Professor, LHMC, New Delhi) to reduce bedside calculation errors and save time." },
    { q: "Is NeoNEST free to use?", a: "Yes. NeoNEST is completely free for all healthcare professionals. There are no subscriptions, ads, or in-app purchases." },
    { q: "Is my patient data safe?", a: "All clinical data — TPN calculations, nutrition audits, and baby-related entries — stays entirely on your device. No patient data is transmitted to any server. Only your profile info (name, email, hospital) is synced for cross-device access. See the Privacy & Disclaimer page for full details." },
    { q: "What are 'Default Settings' and how do they work?", a: "Default Settings (accessible via the Settings page in the hamburger menu) let you pre-fill values that auto-populate every new TPN calculation. This saves time because you don't have to re-enter your unit's standard protocols each time.\n\nFactory defaults include: Weight 1000g, TFR 100 mL/kg/d, Feeds 0 (NPO), Amino acids 3 g/kg/d, Lipids 3 g/kg/d, GIR 6 mg/kg/min, Na 3 mEq/kg/d, K 2 mEq/kg/d, AA source Aminoven, Na source 3% NaCl, MVI 1 mL/kg/d, Celcel 0, Overfill 1x.\n\nYou can customize these to match your NICU's preferred starting values, and hit 'Factory Reset' anytime to restore the original defaults." },
    { q: "What does the 'Overfill' setting mean?", a: "Overfill controls how syringe volumes are displayed:\n• Overfill = 1: Volumes are shown as 'Per 50 mL' (for making in a standard 50 mL syringe).\n• Overfill > 1 (e.g. 1.1 or 1.2): Full-day volumes are calculated with 10–20% extra to account for syringe priming and line dead-space. The output then shows both the base volume and the adjusted volume." },
    { q: "What is the difference between 2-syringe and 3-syringe TPN?", a: "In 2-syringe mode:\n• Syringe 1 = Lipid + MVI + Celcel\n• Syringe 2 = Amino acids + Electrolytes + Dextrose\n\nIn 3-syringe mode:\n• Syringe 1 = Lipid + MVI + Celcel\n• Syringe 2 = Amino acids + Electrolytes only\n• Syringe 3 = Dextrose only\n\n3-syringe mode is useful when you want to titrate dextrose separately (e.g. for glucose instability)." },
    { q: "What is the difference between Aminoven and Pentamin?", a: "Both are 10% amino acid solutions used for neonatal TPN.\n• Aminoven: Pure amino acids with no added electrolytes.\n• Pentamin: Contains 8.7 mEq Na and 1.5 mEq K per 100 mL.\n\nThe calculator automatically adjusts Na and K volumes when Pentamin is selected, so you get the correct final electrolyte delivery." },
    { q: "What does '3% NaCl' vs 'Conc. RL (CRL)' mean?", a: "These are two sodium sources for TPN:\n• 3% NaCl: Standard hypertonic saline (0.51 mEq Na/mL).\n• Conc. RL (Concentrated Ringer Lactate): Alternative preparation (~1.5 mEq Na/mL), resulting in smaller volumes.\n\nChoose whichever is available at your institution. The calculator adjusts volumes accordingly." },
    { q: "Can I use NeoNEST offline?", a: "Yes. Once the app is loaded in your browser, all calculators work fully offline. TPN calculations, GIR calculations, and nutrition audits do not require an internet connection. An internet connection is only needed the very first time you open the app and during profile setup." },
    { q: "What is the GIR Calculator used for?", a: "The GIR (Glucose Infusion Rate) Calculator helps you determine the dextrose concentration needed to achieve a target GIR based on available fluid volume, or conversely, what GIR a given dextrose setup will deliver. It's useful for quick bedside glucose management decisions independent of full TPN planning." },
    { q: "What is the Nutrition Audit tool?", a: "The Nutrition Audit tool lets you track and document actual nutritional intake (calories, protein, fluids) a baby received over a day. It helps identify gaps between prescribed and delivered nutrition, supporting quality improvement and structured documentation." },
    { q: "How do HMF/PTF settings work?", a: "In Settings, you configure the calories and protein per gram of your Human Milk Fortifier (HMF) or Protein-Targeted Fortifier (PTF).\n• If protein per gram ≥ 0.2 g/g → labeled as HMF\n• If protein per gram < 0.2 g/g → labeled as PTF\n\nStrength options (Quarter / Half / Full) correspond to 1g per 100 mL, 1g per 50 mL, and 1g per 25 mL of feeds respectively. The app automatically calculates additional calories and protein from fortification." },
    { q: "What do the EBM and Formula calorie/protein defaults mean?", a: "These are the assumed nutritional values per 100 mL of enteral feeds:\n• EBM (Expressed Breast Milk): Default 67 kcal and 1.1 g protein per 100 mL.\n• Formula: Default 78 kcal and 1.9 g protein per 100 mL.\n\nYou can adjust these in Settings to match the specific products used at your center." },
    { q: "Can multiple people use NeoNEST on the same device?", a: "NeoNEST currently supports a single profile per device/browser. If multiple users share a device, they will share the same profile and default settings. Each user should ideally use their own device or browser for accurate profile tracking." },
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
      appVersion: "NeoNEST v1.0",
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
          device_id: getDeviceId(), device: entry.device, browser: entry.browser, screen: entry.screen, app_version: "NeoNEST v1.0"
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
        <div><div style={{ fontSize: 16, fontWeight: 700, color: T.t1 }}>Contact & Feedback</div><div style={{ fontSize: 11, color: T.t3 }}>Help us improve NeoNEST</div></div>
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
  const s = k => v => setF(p => ({ ...p, [k]: v }));
  const inp = { width: "100%", height: 42, padding: "0 12px", fontSize: 14, fontWeight: 600, background: T.inp, border: "1.5px solid " + T.inpBorder, borderRadius: 10, color: T.t1, outline: "none", fontFamily: "inherit", boxSizing: "border-box" };
  const sel = { ...inp, cursor: "pointer", WebkitAppearance: "none", appearance: "none", backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23999'/%3E%3C/svg%3E\")", backgroundRepeat: "no-repeat", backgroundPosition: "right 10px center" };
  const lbl = { fontSize: 11, color: T.t3, fontWeight: 600, textTransform: "uppercase", display: "block", marginBottom: 5 };
  const filteredCountries = cq.length > 0 ? COUNTRIES.filter(c => c.toLowerCase().startsWith(cq.toLowerCase())).slice(0, 6) : [];
  const canStep1 = f.name.trim() && f.email.includes("@");
  const canStep2 = f.hospital.trim() && f.city.trim();

  const doSave = async () => {
    await storeSet("user_profile", JSON.stringify(f));
    supabaseUpsertProfile(f);
    onDone(f);
  };

  return <div style={{ minHeight: "100vh", background: T.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 20 }}>
    <div style={{ width: "100%", maxWidth: 380 }}>
      <div style={{ textAlign: "center", marginBottom: 24 }}>
        <Logo T={T} width={200} />
        <h1 style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 700, color: T.t1 }}>Welcome!</h1>
        <p style={{ margin: 0, fontSize: 13, color: T.t3 }}>Set up your profile to get started</p>
      </div>

      {/* Progress */}
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
    </div>
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
