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
const LOGO_LIGHT = "data:image/png;base64,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i69W7/v8zLnbfMPveu3aZoHHBfwvQjCwBAgQIOD/ILz9Xh/YONHYAtptLA4v6y5ezokIDnr12rV6MDYy7Zcv629frDW5naqocWptqL9Z2YC6TAgPGeHDyWgPNlAWwAVLJNxjpHvzuAiZ58mSqhvjImRenZuIpKSOTdgDzLESIECAAAECBAj4xZGeni7CYcQHZcwpFAongdICBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIOC/AISjP6anp4vi4+MJgTwCBAgQIECAAAFdIz8/n1OpVFaBEgIECBAgQIAAAQ8Yd3ip0tPTRSqVyqpISope/OILT/h6iq5b26we99y6yNa8lev9d/no7jn+9/nfE/XS8dbdM/bvFRGO/9abvoru0xFo5Xpu417o25tn7mXO+kL3ntrA3xX1ozPV0bj7o/3e9LWr7+A5vl8+fhDoqh/2fMkfW2/XraN16IgW98ODXfHbvfDhL4nejvNhjuNe39UXvdBXed/d+nbEo6L/wkBNV2Psja7o63x1t/57mi/+Wu5NO13NcW/m/37G3pNs7oEWQ4bFEnn/Odj64qJFmwE4AoDg7jKwFAqFk1arbVckJUUrf/PK0cjANrK9jRVMUAECBAgQIECAgG6g+sfX/9y2dcsylmURQogFAHDCH4aFhXVYXdbbkyID28jjRw60tLVawdlFBG2tHaFFZxdRZ2NOInSHiXn7dlu35qOziwicRIhrt7IEbo//Gb/dditLdPV/AOiyP7jtAQOcOQCArp7rqZ89vctRW/zPe/Oee8GAAc6cPZ3xWG/fbiPw747mxdGzeE4cfQf/jsfFp2tf5r039O4tvboaf1/6wOdD+88c9QP3zxFt+PPObxOvje765YiW9wL7teLoc/64+P3tqh3+eBy12dt3C+j7XPLpfq9rqzdrwp6Hu1qDXcn/vsy5o7XmCPz2HOkJ+zXIp1lX77Xn/d7qgPuhf1/nhy/De/NsV+PG43WkqxzNI36+u/npji96mkf7ueotj/RGXjnSP93Z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";
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
