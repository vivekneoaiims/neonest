import storage from "./storage";
import { useState, useCallback, useMemo, useRef, useEffect } from "react";

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
    mon: { tfv, feeds: feedsMl, ivfKg: ivfPerKg, ivfMl, tpn: tpnFluid, tpnG: tpnGlucose, gFluid: fluidForGlc,
      dex: dexPct, cnr, osm: oD > 0 ? (oN / oD) * 1000 : 0,
      cal: (aminoAcid * 4) + (lipid * 9) + (gir * 5) + fCal + pCal,
      prot: aminoAcid + fProt + pProt, naIVM: naInIVM, gIVM: glcInIVM, kPP: kFromPP },
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
const LOGO_LIGHT = "/logo-light.png";
const LOGO_DARK = "/logo-dark.png";
const ICO_TPN = "/icon-tpn.png";
const ICO_GIR = "/icon-gir.png";
const ICO_NUT = "/icon-nut.png";
const LOGO_LIGHT_C = "/logo-light-c.png";
const LOGO_DARK_C = "/logo-dark-c.png";
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
  const show = () => { if (soi) soi(id) };
  const hide = () => { if (soi && isOpen) soi(null) };
  return <span style={{ position: "relative", display: "inline-flex", zIndex: isOpen ? 201 : 1 }}
    onMouseEnter={show} onMouseLeave={hide}>
    <button onClick={e => { e.preventDefault(); e.stopPropagation(); if (soi) soi(isOpen ? null : id) }} onMouseDown={e => e.stopPropagation()}
      style={{ width: 15, height: 15, borderRadius: 8, fontSize: 8, fontWeight: 800, fontStyle: "italic", background: isOpen ? T.accentDim : "transparent", color: isOpen ? T.accentText : T.t3, border: "1px solid " + (isOpen ? T.accent + "66" : T.border), cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", marginLeft: 4, fontFamily: "Georgia,serif", padding: 0 }}>i</button>
    {isOpen && <div onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}
      style={{ position: "absolute", top: 22, left: "50%", transform: "translateX(-60%)", zIndex: 300, width: 240, padding: "12px 14px", background: T.card, border: "1.5px solid " + T.accent + "44", borderRadius: 12, boxShadow: "0 8px 32px rgba(0,0,0,.18)", fontSize: 11, color: T.t2, lineHeight: 1.6, fontWeight: 400, fontStyle: "normal", whiteSpace: "pre-line", maxWidth: "calc(100vw - 32px)" }}>{HELP[id] || "No info."}</div>}
  </span>;
}

// ━━━ Input Components ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function NI({ label, unit, value, onChange, step = .1, min = 0, max, T, info, oi, soi }) {
  const inc = () => { const n = +(value + step).toFixed(4); onChange(max != null ? Math.min(n, max) : n) };
  const dec = () => onChange(Math.max(+(value - step).toFixed(4), min));
  return <div style={{ flex: "1 1 0", minWidth: 0 }}>
    <div style={{ display: "flex", alignItems: "center", marginBottom: 4, minHeight: 15 }}>
      <label style={{ fontSize: 10, color: T.t3, fontWeight: 600, letterSpacing: ".03em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</label>
      {info && <InfoBtn id={info} T={T} oi={oi} soi={soi} />}
    </div>
    <div style={{ display: "flex", alignItems: "center", background: T.inp, borderRadius: 8, border: "1.5px solid " + T.inpBorder, height: 38, overflow: "hidden" }}>
      <input type="number" value={value} onChange={e => onChange(parseFloat(e.target.value) || 0)} step={step} min={min} max={max}
        style={{ width: 0, flex: "1 1 auto", padding: "0 0 0 8px", fontSize: 14, fontWeight: 700, background: "transparent", border: "none", color: T.t1, outline: "none", fontFamily: "'JetBrains Mono',monospace", minWidth: 0 }}
        onFocus={e => e.currentTarget.parentElement.style.borderColor = T.inpFocus} onBlur={e => e.currentTarget.parentElement.style.borderColor = T.inpBorder} />
      {unit && <span style={{ fontSize: 10, color: T.t3, fontWeight: 500, whiteSpace: "nowrap", paddingRight: 4, paddingLeft: 2 }}>{unit}</span>}
      <div style={{ display: "flex", flexDirection: "column", borderLeft: "1px solid " + T.inpBorder, height: "100%", flexShrink: 0, width: 24 }}>
        <button onClick={inc} style={{ flex: 1, background: T.stepBg, border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: T.t2, borderBottom: ".5px solid " + T.inpBorder, padding: 0 }} onMouseEnter={e => e.currentTarget.style.background = T.stepHover} onMouseLeave={e => e.currentTarget.style.background = T.stepBg}><svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 6.5L5 3.5L8 6.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" /></svg></button>
        <button onClick={dec} style={{ flex: 1, background: T.stepBg, border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: T.t2, padding: 0 }} onMouseEnter={e => e.currentTarget.style.background = T.stepHover} onMouseLeave={e => e.currentTarget.style.background = T.stepBg}><svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" /></svg></button>
      </div>
    </div>
  </div>;
}
function Row({ children }) { const c = Array.isArray(children) ? children.filter(Boolean).length : 1; return <div style={{ display: "grid", gridTemplateColumns: "repeat(" + c + ", 1fr)", gap: 8, marginBottom: 8, alignItems: "end" }}>{children}</div> }
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
function useStore(key, fb) {
  const [v, setV] = useState(fb); const [ld, setLd] = useState(false);
  useEffect(() => { (async () => { try { const r = await storage.get(key); if (r?.value) setV(JSON.parse(r.value)) } catch { } setLd(true) })() }, [key]);
  const save = useCallback(async nv => { setV(nv); try { await storage.set(key, JSON.stringify(nv)) } catch { } }, [key]);
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
        {[["profile", "\ud83d\udc64", "Profile"], ["settings", "\u2699\ufe0f", "Settings"], ["contact", "\ud83d\udce7", "Contact Us"], ["about", "\u2139\ufe0f", "About & Privacy"]].map(([id, ic, lb]) => (
          <button key={id} onClick={() => { onNav(id); onClose() }} style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "14px 20px", background: "transparent", border: "none", cursor: "pointer", fontSize: 14, color: T.t1, fontWeight: 500, textAlign: "left" }}><span style={{ fontSize: 18 }}>{ic}</span>{lb}</button>
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

  useEffect(() => { (async () => { try { const r = await storage.get("baby_history"); if (r?.value) { const all = JSON.parse(r.value); const cutoff = Date.now() - 30 * 86400000; setBabyHist(all.filter(b => new Date(b.ts).getTime() > cutoff)) } } catch {} })() }, []);

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
    try { await storage.set("baby_history", JSON.stringify(updated)); setBabyHist(updated); alert("Saved!") } catch { alert("Save failed") }
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
        <div style={{ position: "relative" }}><label style={{ fontSize: 10, color: T.t3, fontWeight: 600, textTransform: "uppercase", display: "block", marginBottom: 4 }}>Baby of (Mother)</label><input value={ip.babyOf} onChange={e => { s("babyOf")(e.target.value); setLoadedBaby(null) }} onFocus={() => setNameFocus(true)} onBlur={() => setTimeout(() => setNameFocus(false), 150)} placeholder="Mother's name" style={{ width: "100%", height: 38, padding: "0 8px", fontSize: 13, fontWeight: 600, background: T.inp, border: "1.5px solid " + T.inpBorder, borderRadius: 8, color: T.t1, outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
          {nameSugg.length > 0 && <div style={ddStyle}>{nameSugg.map((b, i) => <div key={i} onMouseDown={() => loadBaby(b)} style={ddItem} onMouseEnter={e => e.currentTarget.style.background = T.accentDim} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <div style={{ fontSize: 12, fontWeight: 600, color: T.t1 }}>{b.babyOf}</div>
            <div style={{ fontSize: 10, color: T.t3 }}>{b.patientId ? "ID: " + b.patientId + " | " : ""}{new Date(b.ts).toLocaleDateString()}</div>
          </div>)}</div>}
        </div>
        <div style={{ position: "relative" }}><label style={{ fontSize: 10, color: T.t3, fontWeight: 600, textTransform: "uppercase", display: "block", marginBottom: 4 }}>Patient ID</label><input value={ip.patientId} onChange={e => { s("patientId")(e.target.value.replace(/\D/g, "")); setLoadedBaby(null) }} onFocus={() => setIdFocus(true)} onBlur={() => setTimeout(() => setIdFocus(false), 150)} placeholder="Numeric" inputMode="numeric" style={{ width: "100%", height: 38, padding: "0 8px", fontSize: 13, fontWeight: 600, background: T.inp, border: "1.5px solid " + T.inpBorder, borderRadius: 8, color: T.t1, outline: "none", fontFamily: "'JetBrains Mono',monospace", boxSizing: "border-box" }} />
          {idSugg.length > 0 && <div style={ddStyle}>{idSugg.map((b, i) => <div key={i} onMouseDown={() => loadBaby(b)} style={ddItem} onMouseEnter={e => e.currentTarget.style.background = T.accentDim} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <div style={{ fontSize: 12, fontWeight: 600, color: T.t1 }}>{b.patientId}</div>
            <div style={{ fontSize: 10, color: T.t3 }}>{b.babyOf ? b.babyOf + " | " : ""}{new Date(b.ts).toLocaleDateString()}</div>
          </div>)}</div>}
        </div>
        <div><label style={{ fontSize: 10, color: T.t3, fontWeight: 600, textTransform: "uppercase", display: "block", marginBottom: 4 }}>Date</label><input type="date" value={ip.date} onChange={e => s("date")(e.target.value)} style={{ width: "100%", height: 38, padding: "0 6px", fontSize: 12, fontWeight: 600, background: T.inp, border: "1.5px solid " + T.inpBorder, borderRadius: 8, color: T.t1, outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} /></div>
      </div>
    </div>

    <Sec title="Patient & Fluids" open={sec.pat} onToggle={() => t("pat")} T={T}>
      <Row><NI label="Weight" unit="g" value={ip.weightG} onChange={s("weightG")} step={10} min={0} max={9999} T={T} info="weight" oi={oi} soi={soi} /><NI label="TFR" unit="mL/kg/d" value={ip.tfr} onChange={s("tfr")} step={5} T={T} info="tfr" oi={oi} soi={soi} /><NI label="Feeds" unit="mL/kg/d" value={ip.feeds} onChange={s("feeds")} step={5} T={T} info="feeds" oi={oi} soi={soi} /><NI label="IVM" unit="mL" value={ip.ivm} onChange={s("ivm")} step={1} T={T} info="ivm" oi={oi} soi={soi} /></Row>
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
      <Row><Pills label="Low dextrose" value={ip.use5Dex ? "5%" : "10%"} options={[{ label: "5%", value: "5%" }, { label: "10%", value: "10%" }]} onChange={v => s("use5Dex")(v === "5%")} T={T} info="dex" oi={oi} soi={soi} /><Pills label="High dextrose" value={ip.use25Dex ? "25%" : "50%"} options={[{ label: "25%", value: "25%" }, { label: "50%", value: "50%" }]} onChange={v => s("use25Dex")(v === "25%")} T={T} /><Tog label="Ca in TPN" value={ip.caViaTPN} onChange={s("caViaTPN")} T={T} info="caInTPN" oi={oi} soi={soi} /><Tog label="PO4 in TPN" value={ip.po4ViaTPN} onChange={s("po4ViaTPN")} T={T} info="po4InTPN" oi={oi} soi={soi} /></Row>
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
        <button onClick={saveTPN} style={{ flex: 1, padding: 12, fontSize: 13, fontWeight: 700, background: T.card, color: T.accentText, border: "1.5px solid " + T.accent + "33", borderRadius: 10, cursor: "pointer" }}>Save</button>
        <button onClick={() => window.print()} style={{ flex: 1, padding: 12, fontSize: 13, fontWeight: 700, background: T.card, color: T.t2, border: "1.5px solid " + T.border, borderRadius: 10, cursor: "pointer" }}>Print</button>
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
        {!isSingle && <NI label="Target GIR" unit="mg/kg/min" value={targetGir} onChange={setTargetGir} step={0.5} min={0} T={T} info="gir" oi={oi} soi={soi} />}
      </Row>
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
  { k:"energy", n:"Energy", u:"kcal/kg", bm:52, fm:78, hm:4, aap:[105,130], esp:[110,135] },
  { k:"protein", n:"Protein", u:"g/kg", bm:0.95, fm:1.9, hm:0.3, aap:[3.5,4.0], esp:[3.5,4.0] },
  { k:"fat", n:"Fat", u:"g/kg", bm:3.6, fm:3.8, hm:0.1, aap:[5.0,7.0], esp:[4.8,6.6] },
  { k:"carb", n:"Carbohydrate", u:"g/kg", bm:6.7, fm:8.1, hm:0.4, aap:[10.0,14], esp:[11.6,13.2] },
  { k:"ca", n:"Calcium", u:"mg/kg/d", bm:26, fm:95, hm:15.93, aap:[200,210], esp:[120,140], sup:true },
  { k:"po4", n:"Phosphorus", u:"mg/kg/d", bm:13, fm:48, hm:8.76, aap:[100,110], esp:[60,90] },
  { k:"fe", n:"Iron", u:"mg/kg/d", bm:0.12, fm:1.67, hm:0.36, aap:[2.0,3.0], esp:[2.0,3.0], sup:true },
  { k:"vitd", n:"Vitamin D", u:"IU/d", bm:2, fm:160, hm:28, aap:[400,400], esp:[800,1000], perDay:true },
  { k:"na", n:"Sodium", u:"mEq/kg/d", bm:1.4, fm:1.03, hm:0.32, aap:[2.0,3.0], esp:[3.0,5.0] },
  { k:"k", n:"Potassium", u:"mEq/kg/d", bm:2.4, fm:0.74, hm:0.25, aap:[1.7,2.5], esp:[3.0,5.0] },
  { k:"mg", n:"Magnesium", u:"mg/kg/d", bm:3, fm:3.7, hm:0.8, esp:[8.0,15.0] },
  { k:"zn", n:"Zinc", u:"mg/kg/d", bm:0.33, fm:0.28, hm:0.19, aap:[0.6,1.0], esp:[1.1,2.0] },
  { k:"vita", n:"Vitamin A", u:"IU/kg/d", bm:50, fm:505, hm:221.6, aap:[92,270], esp:[1330,3300] },
  { k:"vite", n:"Vitamin E", u:"IU/kg/d", bm:1.5, fm:1.11, hm:1.12, aap:[1.3,1.3], esp:[2.2,11] },
  { k:"vitk", n:"Vitamin K", u:"mcg/kg/d", bm:0.2, fm:6.67, hm:1.5, aap:[4.8,4.8], esp:[4.4,28] },
  { k:"vitc", n:"Vitamin C", u:"mg/kg/d", bm:10.6, fm:6.67, hm:3.75, aap:[42,42], esp:[11,46] },
  { k:"folic", n:"Folic acid", u:"mcg/kg/d", bm:3.3, fm:16.7, hm:7.5, aap:[40,40], esp:[35,100] },
  { k:"cu", n:"Copper", u:"mcg/kg/d", bm:73, fm:35.6, hm:10, aap:[100,108], esp:[100,132] },
];
function mergeNutDB(overrides) {
  if (!overrides) return NUTRIENTS;
  return NUTRIENTS.map(nut => {
    const ov = overrides[nut.k];
    if (!ov) return nut;
    return { ...nut,
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
  const hmfG = ip.hmfMode === "feed" ? ip.hmfPerFeed * ip.feedsPerDay : ip.hmfPerDay;
  const wtGain = ip.wtLast > 0 ? ((ip.wtNow - ip.wtLast) / ip.wtLast) * 1000 / 7 : 0;
  const rows = db.map(nut => {
    let fromEbm = ebmMl * nut.bm / 100;
    let fromFm = fmMl * nut.fm / 100;
    let fromHmf = hmfG * nut.hm;
    let fromSup = 0;
    if (nut.k === "ca") fromSup = ip.caMl * ip.caConc;
    if (nut.k === "fe") fromSup = ip.feMl * ip.feConc;
    if (nut.k === "vitd") fromSup = ip.vitdIU;
    if (nut.k === "po4") fromSup = ip.po4Ml * ip.po4Conc;
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
function NutDBEditor({ T, nutOv, saveNutOv, onClose }) {
  const [tab, setTab] = useState("bm");
  const [d, setD] = useState(() => {
    const init = {};
    NUTRIENTS.forEach(nut => {
      const ov = nutOv?.[nut.k] || {};
      init[nut.k] = { bm: ov.bm ?? nut.bm, fm: ov.fm ?? nut.fm, hm: ov.hm ?? nut.hm,
        aap: ov.aap ? [...ov.aap] : (nut.aap ? [...nut.aap] : [0, 0]),
        esp: ov.esp ? [...ov.esp] : (nut.esp ? [...nut.esp] : [0, 0]) };
    });
    return init;
  });
  const upd = (k, field, val) => setD(p => ({ ...p, [k]: { ...p[k], [field]: val } }));
  const updRda = (k, field, idx, val) => setD(p => { const arr = [...(p[k][field] || [0, 0])]; arr[idx] = val; return { ...p, [k]: { ...p[k], [field]: arr } }; });
  const tabs = [{ id: "bm", l: "EBM", sub: "per 100 mL" }, { id: "fm", l: "Formula", sub: "per 100 mL" }, { id: "hm", l: "HMF/PTF", sub: "per gram" }, { id: "aap", l: "AAP", sub: "RDA range" }, { id: "esp", l: "ESPGHAN", sub: "RDA range" }];
  const isRda = tab === "aap" || tab === "esp";
  return <div style={{ background: T.card, borderRadius: 12, border: "1px solid " + T.border, boxShadow: T.shadow, marginBottom: 8, overflow: "hidden" }}>
    <div style={{ display: "flex", alignItems: "center", padding: "10px 12px", borderBottom: "1px solid " + T.border }}>
      <div style={{ flex: 1 }}><div style={{ fontSize: 13, fontWeight: 700, color: T.t1 }}>Nutrition Database</div><div style={{ fontSize: 10, color: T.t3 }}>Edit values and save as your defaults</div></div>
      <button onClick={onClose} style={{ width: 28, height: 28, borderRadius: 14, background: T.inp, border: "1px solid " + T.border, cursor: "pointer", fontSize: 14, color: T.t3, display: "flex", alignItems: "center", justifyContent: "center" }}>&times;</button>
    </div>
    <div style={{ display: "flex", gap: 2, padding: "6px 8px", overflowX: "auto", borderBottom: "1px solid " + T.border }}>
      {tabs.map(t => <button key={t.id} onClick={() => setTab(t.id)} style={{ padding: "6px 8px", fontSize: 9, fontWeight: tab === t.id ? 700 : 500, background: tab === t.id ? T.accentDim : "transparent", color: tab === t.id ? T.accentText : T.t3, border: tab === t.id ? "1px solid " + T.accent + "33" : "1px solid transparent", borderRadius: 6, cursor: "pointer", whiteSpace: "nowrap", textAlign: "center", lineHeight: 1.3 }}><div>{t.l}</div><div style={{ fontSize: 7, fontWeight: 400 }}>{t.sub}</div></button>)}
    </div>
    <div style={{ maxHeight: 320, overflowY: "auto", padding: "4px 8px" }}>
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
            <input type="number" value={val[tab][0]} onChange={e => updRda(nut.k, tab, 0, parseFloat(e.target.value) || 0)} step={0.1} style={inpSt} />
            <input type="number" value={val[tab][1]} onChange={e => updRda(nut.k, tab, 1, parseFloat(e.target.value) || 0)} step={0.1} style={inpSt} />
          </> : <input type="number" value={val[tab]} onChange={e => upd(nut.k, tab, parseFloat(e.target.value) || 0)} step={0.01} style={inpSt} />}
        </div>;
      })}
    </div>
    <div style={{ display: "flex", gap: 6, padding: "8px 10px", borderTop: "1px solid " + T.border }}>
      <button onClick={() => { saveNutOv(d); alert("Nutrition database saved!") }} style={{ flex: 1, padding: 10, fontSize: 13, fontWeight: 700, background: T.btnGrad, color: "#fff", border: "none", borderRadius: 8, cursor: "pointer" }}>Save Defaults</button>
      <button onClick={() => { saveNutOv(null); const init = {}; NUTRIENTS.forEach(nut => { init[nut.k] = { bm: nut.bm, fm: nut.fm, hm: nut.hm, aap: nut.aap ? [...nut.aap] : [0,0], esp: nut.esp ? [...nut.esp] : [0,0] }; }); setD(init); alert("Reset to factory values!") }} style={{ padding: "10px 14px", fontSize: 11, fontWeight: 600, background: T.card, color: T.red, border: "1px solid " + T.red + "33", borderRadius: 8, cursor: "pointer" }}>Reset</button>
    </div>
  </div>;
}
function NutritionPage({ T, defaults, nutOv, saveNutOv }) {
  const [ip, setIp] = useState({ babyOf: "", patientId: "", date: todayStr(), wtNow: 1500, wtLast: 1400, mode: "day", perFeed: 15, feedsPerDay: 8, totalMlKg: 150,
    feedSrc: "EBM", ebmPct: 70, hmfMode: "day", hmfPerFeed: 0, hmfPerDay: 0,
    caMl: 0, caConc: 16, feMl: 0, feConc: 10, po4Ml: 0, po4Conc: 30, vitdIU: 400 });
  const [show, setShow] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const s = k => v => setIp(p => ({ ...p, [k]: v }));
  const nutDB = useMemo(() => mergeNutDB(nutOv), [nutOv]);
  const res = useMemo(() => calcNutrition(ip, nutDB), [ip, nutDB]);
  const fortLabel = (defaults?.hmfProtPerG || 0) < 0.2 ? "PTF" : "HMF";
  const statusColor = (st) => st === "low" ? T.red : st === "high" ? T.blue : T.green;
  const statusBg = (st) => st === "low" ? T.red + "0c" : st === "high" ? T.blueBg : T.green + "08";

  return <div>
    <div style={{ background: T.card, borderRadius: 12, border: "1px solid " + T.border, marginBottom: 8, padding: "10px 12px", boxShadow: T.shadow }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
        <div><label style={{ fontSize: 10, color: T.t3, fontWeight: 600, textTransform: "uppercase", display: "block", marginBottom: 4 }}>Baby of (Mother)</label><input value={ip.babyOf} onChange={e => s("babyOf")(e.target.value)} placeholder="Mother's name" style={{ width: "100%", height: 38, padding: "0 8px", fontSize: 13, fontWeight: 600, background: T.inp, border: "1.5px solid " + T.inpBorder, borderRadius: 8, color: T.t1, outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} /></div>
        <div><label style={{ fontSize: 10, color: T.t3, fontWeight: 600, textTransform: "uppercase", display: "block", marginBottom: 4 }}>Patient ID</label><input value={ip.patientId} onChange={e => s("patientId")(e.target.value.replace(/\D/g, ""))} placeholder="Numeric" inputMode="numeric" style={{ width: "100%", height: 38, padding: "0 8px", fontSize: 13, fontWeight: 600, background: T.inp, border: "1.5px solid " + T.inpBorder, borderRadius: 8, color: T.t1, outline: "none", fontFamily: "'JetBrains Mono',monospace", boxSizing: "border-box" }} /></div>
        <div><label style={{ fontSize: 10, color: T.t3, fontWeight: 600, textTransform: "uppercase", display: "block", marginBottom: 4 }}>Date</label><input type="date" value={ip.date} onChange={e => s("date")(e.target.value)} style={{ width: "100%", height: 38, padding: "0 6px", fontSize: 12, fontWeight: 600, background: T.inp, border: "1.5px solid " + T.inpBorder, borderRadius: 8, color: T.t1, outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} /></div>
      </div>
    </div>
    <Sec title="Weight & Growth" open={true} onToggle={() => {}} T={T}>
      <Row><NI label="Today's weight" unit="g" value={ip.wtNow} onChange={s("wtNow")} step={10} T={T} /><NI label="Last week weight" unit="g" value={ip.wtLast} onChange={s("wtLast")} step={10} T={T} /></Row>
      {res && ip.wtLast > 0 && <div style={{ padding: "6px 10px", background: res.wtGain >= 15 ? T.green + "12" : T.amber + "12", borderRadius: 8, fontSize: 12, display: "flex", justifyContent: "space-between" }}>
        <span style={{ color: T.t2 }}>Weight gain</span>
        <span style={{ fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", color: res.wtGain >= 15 ? T.green : T.amber }}>{res.wtGain.toFixed(1)} g/kg/d</span>
      </div>}
    </Sec>

    <Sec title="Feeds" open={true} onToggle={() => {}} T={T}>
      <Row><Pills label="Entry mode" value={ip.mode} options={[{ label: "Per Feed", value: "feed" }, { label: "Per Day", value: "day" }]} onChange={s("mode")} T={T} /></Row>
      {ip.mode === "feed" ? <Row><NI label="mL per feed" unit="mL" value={ip.perFeed} onChange={s("perFeed")} step={1} T={T} /><NI label="Feeds/day" unit="" value={ip.feedsPerDay} onChange={s("feedsPerDay")} step={1} min={1} max={12} T={T} /></Row>
        : <Row><NI label="Total feeds" unit="mL/kg/d" value={ip.totalMlKg} onChange={s("totalMlKg")} step={5} T={T} /></Row>}
      <Row><Pills label="Feed source" value={ip.feedSrc} options={["EBM", "Formula", "Mixed"]} onChange={s("feedSrc")} T={T} /></Row>
      {ip.feedSrc === "Mixed" && <Row><NI label="EBM %" unit="%" value={ip.ebmPct} onChange={s("ebmPct")} step={5} min={0} max={100} T={T} /></Row>}
      <Row><Pills label={fortLabel + " entry"} value={ip.hmfMode} options={[{ label: "Per Feed", value: "feed" }, { label: "Per Day", value: "day" }]} onChange={s("hmfMode")} T={T} />
        {ip.hmfMode === "feed" ? <NI label={fortLabel + "/feed"} unit="g" value={ip.hmfPerFeed} onChange={s("hmfPerFeed")} step={0.25} T={T} /> : <NI label={fortLabel + "/day"} unit="g" value={ip.hmfPerDay} onChange={s("hmfPerDay")} step={0.5} T={T} />}
      </Row>
    </Sec>

    <Sec title="Supplements" open={true} onToggle={() => {}} T={T}>
      <Row><NI label="Ca syrup" unit="mL/d" value={ip.caMl} onChange={s("caMl")} step={0.5} T={T} /><NI label="Ca conc." unit="mg/mL" value={ip.caConc} onChange={s("caConc")} step={1} T={T} /></Row>
      <Row><NI label="Iron syrup" unit="mL/d" value={ip.feMl} onChange={s("feMl")} step={0.5} T={T} /><NI label="Fe conc." unit="mg/mL" value={ip.feConc} onChange={s("feConc")} step={1} T={T} /></Row>
      <Row><NI label="PO4 syrup" unit="mL/d" value={ip.po4Ml} onChange={s("po4Ml")} step={0.5} T={T} /><NI label="PO4 conc." unit="mg/mL" value={ip.po4Conc} onChange={s("po4Conc")} step={1} T={T} /></Row>
      <Row><NI label="Vitamin D" unit="IU/d" value={ip.vitdIU} onChange={s("vitdIU")} step={100} T={T} /></Row>
    </Sec>

    <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
      <button onClick={() => setEditing(!editing)} style={{ flex: 1, padding: "10px 12px", fontSize: 12, fontWeight: 600, background: editing ? T.accentDim : T.card, color: editing ? T.accentText : T.t2, border: "1px solid " + (editing ? T.accent + "44" : T.border), borderRadius: 10, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
        {editing ? "Close Editor" : "Edit Nutrition Database"}
      </button>
    </div>

    {editing && <NutDBEditor T={T} nutOv={nutOv} saveNutOv={saveNutOv} onClose={() => setEditing(false)} />}

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
          {["energy", "protein", "ca", "fe", "vitd"].map(k => { const r = res.rows.find(x => x.k === k); if (!r) return null;
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
  const COUNTRIES = ["Afghanistan","Albania","Algeria","Andorra","Angola","Antigua and Barbuda","Argentina","Armenia","Australia","Austria","Azerbaijan","Bahamas","Bahrain","Bangladesh","Barbados","Belarus","Belgium","Belize","Benin","Bhutan","Bolivia","Bosnia and Herzegovina","Botswana","Brazil","Brunei","Bulgaria","Burkina Faso","Burundi","Cabo Verde","Cambodia","Cameroon","Canada","Central African Republic","Chad","Chile","China","Colombia","Comoros","Congo","Costa Rica","Croatia","Cuba","Cyprus","Czech Republic","Denmark","Djibouti","Dominica","Dominican Republic","Ecuador","Egypt","El Salvador","Equatorial Guinea","Eritrea","Estonia","Eswatini","Ethiopia","Fiji","Finland","France","Gabon","Gambia","Georgia","Germany","Ghana","Greece","Grenada","Guatemala","Guinea","Guinea-Bissau","Guyana","Haiti","Honduras","Hungary","Iceland","India","Indonesia","Iran","Iraq","Ireland","Israel","Italy","Jamaica","Japan","Jordan","Kazakhstan","Kenya","Kiribati","Korea North","Korea South","Kosovo","Kuwait","Kyrgyzstan","Laos","Latvia","Lebanon","Lesotho","Liberia","Libya","Liechtenstein","Lithuania","Luxembourg","Madagascar","Malawi","Malaysia","Maldives","Mali","Malta","Marshall Islands","Mauritania","Mauritius","Mexico","Micronesia","Moldova","Monaco","Mongolia","Montenegro","Morocco","Mozambique","Myanmar","Namibia","Nauru","Nepal","Netherlands","New Zealand","Nicaragua","Niger","Nigeria","North Macedonia","Norway","Oman","Pakistan","Palau","Palestine","Panama","Papua New Guinea","Paraguay","Peru","Philippines","Poland","Portugal","Qatar","Romania","Russia","Rwanda","Saint Kitts and Nevis","Saint Lucia","Saint Vincent and the Grenadines","Samoa","San Marino","Sao Tome and Principe","Saudi Arabia","Senegal","Serbia","Seychelles","Sierra Leone","Singapore","Slovakia","Slovenia","Solomon Islands","Somalia","South Africa","South Sudan","Spain","Sri Lanka","Sudan","Suriname","Sweden","Switzerland","Syria","Taiwan","Tajikistan","Tanzania","Thailand","Timor-Leste","Togo","Tonga","Trinidad and Tobago","Tunisia","Turkey","Turkmenistan","Tuvalu","Uganda","Ukraine","United Arab Emirates","United Kingdom","United States","Uruguay","Uzbekistan","Vanuatu","Vatican City","Venezuela","Vietnam","Yemen","Zambia","Zimbabwe"];
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

    <button onClick={() => { if (!canSave) { alert("Email is required."); return; } saveP(f); alert("Saved!") }} style={{ width: "100%", padding: 12, fontSize: 14, fontWeight: 700, background: canSave ? T.btnGrad : T.inpBorder, color: "#fff", border: "none", borderRadius: 10, cursor: canSave ? "pointer" : "not-allowed", marginTop: 8 }}>Save Profile</button>
  </div>;
}
function AboutPage({ T }) {
  const card = { background: T.card, borderRadius: 12, padding: "16px 16px", border: "1px solid " + T.border, boxShadow: T.shadow, marginBottom: 8 };
  return <div>
    <div style={{ ...card, display: "flex", flexDirection: "column", alignItems: "center", padding: "24px 16px 16px" }}>
      <Logo T={T} width={220} />
      <div style={{ fontSize: 11, color: T.t3, marginTop: 6 }}>v1.0</div>
    </div>

    <div style={card}>
      <div style={{ fontSize: 13, fontWeight: 700, color: T.accentText, marginBottom: 8 }}>About NeoNEST</div>
      <p style={{ fontSize: 12, color: T.t2, lineHeight: 1.8, margin: "0 0 12px" }}>NeoNEST (Neonatal Essential Support Tools) is a clinician-designed digital platform developed to support evidence-based neonatal nutrition and bedside decision-making in NICU settings.</p>
      <p style={{ fontSize: 12, color: T.t2, lineHeight: 1.8, margin: "0 0 8px" }}>Version 1.0 currently includes:</p>
      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        {["30 sec TPN", "GIR Calculator", "Nutrition Audit"].map((t, i) => <div key={i} style={{ flex: 1, padding: "8px 6px", background: T.accentDim, borderRadius: 8, border: "1px solid " + T.accent + "18", textAlign: "center", fontSize: 10, fontWeight: 600, color: T.accentText }}>{t}</div>)}
      </div>
      <p style={{ fontSize: 12, color: T.t2, lineHeight: 1.8, margin: 0 }}>NeoNEST is designed to reduce calculation errors, save bedside time, and promote structured documentation in neonatal units.</p>
    </div>

    <div style={card}>
      <div style={{ fontSize: 13, fontWeight: 700, color: T.accentText, marginBottom: 8 }}>About the Developer</div>
      <p style={{ fontSize: 12, color: T.t2, lineHeight: 1.8, margin: "0 0 10px" }}>Dr. Vivek Kumar is a neonatologist and currently an Assistant Professor at Lady Hardinge Medical College (LHMC), New Delhi. He completed his medical training (MBBS, MD, and DM) at AIIMS, New Delhi.</p>
      <p style={{ fontSize: 12, color: T.t2, lineHeight: 1.8, margin: 0 }}>NeoNEST is a personal, independent project born from his interest in the application of digital technology and Artificial Intelligence to enhance neonatal care.</p>
    </div>

    <div style={{ ...card, background: T.accentDim, border: "1px solid " + T.accent + "25", padding: "16px 18px" }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: T.accentText, marginBottom: 8, letterSpacing: ".03em", textTransform: "uppercase" }}>A note from the developer</div>
      <p style={{ fontSize: 11.5, color: T.t2, lineHeight: 1.9, margin: "0 0 8px", fontStyle: "italic" }}>"In neonatal care, small numbers carry great weight. A minor miscalculation can affect a life measured in grams. NeoNEST was first conceptualized during my DM training at AIIMS, New Delhi, where I developed Excel-based calculators that continue to be used in clinical practice at AIIMS and other centers.</p>
      <p style={{ fontSize: 11.5, color: T.t2, lineHeight: 1.9, margin: "0 0 8px", fontStyle: "italic" }}>Over time, it became clear that thoughtfully designed digital tools could further enhance safety, efficiency, and standardization in the NICU. NeoNEST represents the evolution of that early work into a clinician-friendly application, developed with the assistance of modern digital technologies.</p>
      <p style={{ fontSize: 11.5, color: T.t2, lineHeight: 1.9, margin: "0 0 8px", fontStyle: "italic" }}>It is my hope that this platform supports colleagues in delivering precise, efficient, and compassionate care to the smallest patients we serve."</p>
      <p style={{ fontSize: 12, color: T.accentText, fontWeight: 700, margin: 0, textAlign: "right" }}>— Dr. Vivek Kumar</p>
    </div>

    <div style={card}>
      <div style={{ fontSize: 13, fontWeight: 700, color: T.accentText, marginBottom: 8 }}>Privacy Policy</div>
      <p style={{ fontSize: 12, color: T.t2, lineHeight: 1.8, margin: "0 0 12px" }}>All data processed locally. No patient data transmitted externally. Settings stored in browser local storage only. No analytics, cookies, or third-party services used.</p>
      <div style={{ fontSize: 13, fontWeight: 700, color: T.accentText, marginBottom: 8 }}>Disclaimer</div>
      <p style={{ fontSize: 12, color: T.t2, lineHeight: 1.8, margin: 0 }}>Calculation aid only. All calculations must be verified by the treating physician.</p>
    </div>
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

  useEffect(() => { (async () => { try { const r = await storage.get("feedback_history"); if (r?.value) setHistory(JSON.parse(r.value)) } catch {} })() }, []);

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
    const updated = [entry, ...history].slice(0, 20);
    try { await storage.set("feedback_history", JSON.stringify(updated)) } catch {}
    setHistory(updated);
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
        {history.map((h, i) => { const d = new Date(h.timestamp); return <div key={i} style={{ padding: "8px 10px", marginBottom: 6, background: T.inp, borderRadius: 8, border: "1px solid " + T.border }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: h.type === "Bug Report" ? T.red : h.type === "Feature Request" ? T.green : T.accent }}>{h.type}</span>
            <span style={{ fontSize: 9, color: T.t3 }}>{d.toLocaleDateString()} {d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          </div>
          <div style={{ fontSize: 12, fontWeight: 600, color: T.t1, marginBottom: 2 }}>{h.subject}</div>
          <div style={{ fontSize: 11, color: T.t2, lineHeight: 1.5 }}>{h.message.length > 80 ? h.message.slice(0, 80) + "..." : h.message}</div>
        </div> })}
      </div>}
    </div>}
  </div>;
}


// ━━━ Onboarding ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function Onboarding({ T, onDone }) {
  const COUNTRIES = ["Afghanistan","Albania","Algeria","Andorra","Angola","Argentina","Armenia","Australia","Austria","Azerbaijan","Bahamas","Bahrain","Bangladesh","Barbados","Belarus","Belgium","Belize","Benin","Bhutan","Bolivia","Bosnia and Herzegovina","Botswana","Brazil","Brunei","Bulgaria","Burkina Faso","Burundi","Cabo Verde","Cambodia","Cameroon","Canada","Central African Republic","Chad","Chile","China","Colombia","Comoros","Congo","Costa Rica","Croatia","Cuba","Cyprus","Czech Republic","Denmark","Djibouti","Dominica","Dominican Republic","Ecuador","Egypt","El Salvador","Equatorial Guinea","Eritrea","Estonia","Eswatini","Ethiopia","Fiji","Finland","France","Gabon","Gambia","Georgia","Germany","Ghana","Greece","Grenada","Guatemala","Guinea","Guinea-Bissau","Guyana","Haiti","Honduras","Hungary","Iceland","India","Indonesia","Iran","Iraq","Ireland","Israel","Italy","Jamaica","Japan","Jordan","Kazakhstan","Kenya","Korea South","Kuwait","Kyrgyzstan","Laos","Latvia","Lebanon","Lesotho","Liberia","Libya","Lithuania","Luxembourg","Madagascar","Malawi","Malaysia","Maldives","Mali","Malta","Mauritania","Mauritius","Mexico","Moldova","Mongolia","Montenegro","Morocco","Mozambique","Myanmar","Namibia","Nepal","Netherlands","New Zealand","Nicaragua","Niger","Nigeria","North Macedonia","Norway","Oman","Pakistan","Palestine","Panama","Papua New Guinea","Paraguay","Peru","Philippines","Poland","Portugal","Qatar","Romania","Russia","Rwanda","Saudi Arabia","Senegal","Serbia","Seychelles","Sierra Leone","Singapore","Slovakia","Slovenia","Somalia","South Africa","South Sudan","Spain","Sri Lanka","Sudan","Suriname","Sweden","Switzerland","Syria","Taiwan","Tajikistan","Tanzania","Thailand","Togo","Trinidad and Tobago","Tunisia","Turkey","Turkmenistan","Uganda","Ukraine","United Arab Emirates","United Kingdom","United States","Uruguay","Uzbekistan","Venezuela","Vietnam","Yemen","Zambia","Zimbabwe"];
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
    try { await storage.set("user_profile", JSON.stringify(f)) } catch {}
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
  const T = TH[theme];
  const activePage = menuPage || tab;
  const titles = { tpn: "30 sec TPN Calculator", gir: "GIR Dextrose Calculator", nutrition: "Nutrition Audit", profile: "Profile", settings: "Settings", contact: "Contact Us", about: "About & Privacy" };
  if (!loaded || !profLoaded || !nutLoaded) return <div style={{ minHeight: "100vh", background: TH.classic.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "sans-serif", color: TH.classic.t3 }}>Loading...</div>;

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
    <div style={{ padding: "8px 10px" }}>
      {activePage === "tpn" && <TPNPage T={T} defaults={defaults} />}
      {activePage === "gir" && <GIRPage T={T} />}
      {activePage === "nutrition" && <NutritionPage T={T} defaults={defaults} nutOv={nutOv} saveNutOv={saveNutOv} />}
      {activePage === "settings" && <SettingsPage T={T} defaults={defaults} saveDefaults={saveDefaults} />}
      {activePage === "profile" && <ProfilePage T={T} />}
      {activePage === "about" && <AboutPage T={T} />}
      {activePage === "contact" && <ContactPage T={T} />}
    </div>
    <div className="no-print" style={{ position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)", width: "100%", maxWidth: 480, background: T.navBg, borderTop: "1px solid " + T.navBorder, display: "flex", zIndex: 100, boxShadow: "0 -2px 12px rgba(0,0,0,.08)" }}>
      {[["tpn", ICO_TPN, "30 sec TPN"], ["gir", ICO_GIR, "GIR"], ["nutrition", ICO_NUT, "Nutrition"]].map(([id, ico, lb]) => { const on = tab === id && !menuPage; return <button key={id} onClick={() => { setTab(id); setMenuPage(null) }} style={{ flex: 1, padding: "6px 0 5px", background: "transparent", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 1, opacity: on ? 1 : .45 }}><img src={ico} alt={lb} style={{ width: 28, height: 28, objectFit: "contain" }} /><span style={{ fontSize: 8, fontWeight: on ? 700 : 500, color: on ? T.accentText : T.t3 }}>{lb}</span>{on && <div style={{ width: 20, height: 2, borderRadius: 1, background: T.accent, marginTop: 1 }} />}</button> })}
    </div>
    <style>{`@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}@keyframes slideIn{from{transform:translateX(-100%)}to{transform:translateX(0)}}input[type=number]::-webkit-outer-spin-button,input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}input[type=number]{-moz-appearance:textfield}input[type=date]{-webkit-appearance:none}*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}@media print{.no-print{display:none!important}body{background:#fff!important}.syr-card{break-inside:avoid}}`}</style>
  </div>;
}
