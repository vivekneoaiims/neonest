// Vercel Serverless Function — Supabase Proxy for Profiles
// This runs on Vercel's servers (not in India), bypassing ISP blocks

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
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return res.status(200).json({});
  }

  // Set CORS headers
  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));

  try {
    // GET — Load profile by device_id
    if (req.method === "GET") {
      const deviceId = req.query.device_id;
      if (!deviceId) return res.status(400).json({ error: "device_id required" });

      const url = `${SUPABASE_URL}/rest/v1/profiles?device_id=eq.${deviceId}&select=name,email,mobile,sex,designation,unit,hospital,city,country&limit=1`;
      const response = await fetch(url, { headers });
      const data = await response.json();

      return res.status(200).json(data);
    }

    // POST — Upsert profile (insert or update)
    if (req.method === "POST") {
      const { device_id, ...profileData } = req.body;
      if (!device_id) return res.status(400).json({ error: "device_id required" });

      const body = {
        ...profileData,
        device_id,
        updated_at: new Date().toISOString(),
      };

      // Check if profile exists
      const checkUrl = `${SUPABASE_URL}/rest/v1/profiles?device_id=eq.${device_id}&select=id`;
      const checkRes = await fetch(checkUrl, { headers });
      const existing = await checkRes.json();

      if (existing && existing.length > 0) {
        // Update
        const updateUrl = `${SUPABASE_URL}/rest/v1/profiles?device_id=eq.${device_id}`;
        await fetch(updateUrl, {
          method: "PATCH",
          headers: { ...headers, Prefer: "return=minimal" },
          body: JSON.stringify(body),
        });
      } else {
        // Insert
        const insertUrl = `${SUPABASE_URL}/rest/v1/profiles`;
        await fetch(insertUrl, {
          method: "POST",
          headers: { ...headers, Prefer: "return=minimal" },
          body: JSON.stringify(body),
        });
      }

      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("Supabase proxy error:", e);
    return res.status(500).json({ error: "Server error" });
  }
}
