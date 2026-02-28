// Vercel Serverless Function — Supabase Proxy for Profiles
// This runs on Vercel's servers (not in India), bypassing ISP blocks
// Supports three GET call patterns:
//   1. ?device_id=<id>              → auto-login on known device
//   2. ?device_id=<id>&email=<e>   → auto-login with email fallback (cache cleared scenario)
//   3. ?email=<e>                  → "Already registered?" quick login (no device_id needed)

const SUPABASE_URL = process.env.SUPABASE_URL || "https://hilnfjnvrkjllhnuasku.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhpbG5mam52cmtqbGxobnVhc2t1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIxODA2ODQsImV4cCI6MjA4Nzc1NjY4NH0.UBtLttpTD_YdU34VIFdjZgBW9hgHTWDbmSx82UKoNFU";

const headers = {
  apikey: SUPABASE_KEY,
  Authorization: "Bearer " + SUPABASE_KEY,
  "Content-Type": "application/json",
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    return res.status(200).json({});
  }

  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));

  try {
    // ── GET — Load profile ────────────────────────────────────────────────────
    // Must supply at least one of: device_id or email
    if (req.method === "GET") {
      const deviceId = req.query.device_id;
      const email = req.query.email;

      if (!deviceId && !email) {
        return res.status(400).json({ error: "device_id or email required" });
      }

      // Step 1: Try by device_id (skip if not provided — e.g. email-only login)
      if (deviceId) {
        const url1 = `${SUPABASE_URL}/rest/v1/profiles?device_id=eq.${deviceId}&select=name,email,mobile,sex,designation,unit,hospital,city,country&limit=1`;
        const res1 = await fetch(url1, { headers });
        const data1 = await res1.json();
        if (data1 && data1.length > 0) {
          return res.status(200).json(data1);
        }
      }

      // Step 2: Try by email
      // Covers both: (a) cache-cleared fallback with device_id present,
      //              (b) "Already registered?" login with no device_id
      if (email) {
        const url2 = `${SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(email)}&select=name,email,mobile,sex,designation,unit,hospital,city,country,device_id&limit=1`;
        const res2 = await fetch(url2, { headers });
        const data2 = await res2.json();

        if (data2 && data2.length > 0) {
          // If we have a new device_id and it differs from the stored one, re-link it now
          // (this handles the cache-cleared scenario gracefully)
          const oldDeviceId = data2[0].device_id;
          if (deviceId && oldDeviceId && oldDeviceId !== deviceId) {
            const updateUrl = `${SUPABASE_URL}/rest/v1/profiles?device_id=eq.${oldDeviceId}`;
            await fetch(updateUrl, {
              method: "PATCH",
              headers: { ...headers, Prefer: "return=minimal" },
              body: JSON.stringify({ device_id: deviceId, updated_at: new Date().toISOString() }),
            });
          }
          // Strip device_id before returning — client doesn't need it
          const { device_id: _, ...profileData } = data2[0];
          return res.status(200).json([profileData]);
        }
      }

      // Not found by either identifier
      return res.status(200).json([]);
    }

    // ── POST — Upsert profile ─────────────────────────────────────────────────
    // Check device_id first, then email, then insert new row
    if (req.method === "POST") {
      const { device_id, ...profileData } = req.body;
      if (!device_id) return res.status(400).json({ error: "device_id required" });

      const body = {
        ...profileData,
        device_id,
        updated_at: new Date().toISOString(),
      };

      // Step 1: Check by device_id
      const checkUrl1 = `${SUPABASE_URL}/rest/v1/profiles?device_id=eq.${device_id}&select=id`;
      const checkRes1 = await fetch(checkUrl1, { headers });
      const existing1 = await checkRes1.json();

      if (existing1 && existing1.length > 0) {
        const updateUrl = `${SUPABASE_URL}/rest/v1/profiles?device_id=eq.${device_id}`;
        await fetch(updateUrl, {
          method: "PATCH",
          headers: { ...headers, Prefer: "return=minimal" },
          body: JSON.stringify(body),
        });
        return res.status(200).json({ ok: true });
      }

      // Step 2: Check by email (same person, new device/cleared cache)
      if (profileData.email) {
        const checkUrl2 = `${SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(profileData.email)}&select=id,device_id`;
        const checkRes2 = await fetch(checkUrl2, { headers });
        const existing2 = await checkRes2.json();

        if (existing2 && existing2.length > 0) {
          const oldDeviceId = existing2[0].device_id;
          const updateUrl = `${SUPABASE_URL}/rest/v1/profiles?device_id=eq.${oldDeviceId}`;
          await fetch(updateUrl, {
            method: "PATCH",
            headers: { ...headers, Prefer: "return=minimal" },
            body: JSON.stringify(body),
          });
          return res.status(200).json({ ok: true });
        }
      }

      // Step 3: Truly new user — insert
      const insertUrl = `${SUPABASE_URL}/rest/v1/profiles`;
      await fetch(insertUrl, {
        method: "POST",
        headers: { ...headers, Prefer: "return=minimal" },
        body: JSON.stringify(body),
      });

      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("Supabase proxy error:", e);
    return res.status(500).json({ error: "Server error" });
  }
}
