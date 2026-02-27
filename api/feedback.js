// Vercel Serverless Function — Supabase Proxy for Feedback
// Receives feedback from users and stores in Supabase feedback table

const SUPABASE_URL = process.env.SUPABASE_URL || "https://hilnfjnvrkjllhnuasku.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhpbG5mam52cmtqbGxobnVhc2t1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIxODA2ODQsImV4cCI6MjA4Nzc1NjY4NH0.UBtLttpTD_YdU34VIFdjZgBW9hgHTWDbmSx82UKoNFU";

const headers = {
  apikey: SUPABASE_KEY,
  Authorization: "Bearer " + SUPABASE_KEY,
  "Content-Type": "application/json",
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    return res.status(200).json({});
  }

  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = req.body;

    const row = {
      type: body.type || "",
      priority: body.priority || "Medium",
      subject: body.subject || "",
      message: body.message || "",
      profile_name: body.profile_name || "",
      profile_email: body.profile_email || "",
      profile_designation: body.profile_designation || "",
      profile_hospital: body.profile_hospital || "",
      profile_city: body.profile_city || "",
      device_id: body.device_id || "",
      device: body.device || "",
      browser: body.browser || "",
      screen: body.screen || "",
      app_version: body.app_version || "",
      created_at: new Date().toISOString(),
    };

    const response = await fetch(`${SUPABASE_URL}/rest/v1/feedback`, {
      method: "POST",
      headers: { ...headers, Prefer: "return=minimal" },
      body: JSON.stringify(row),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("Supabase feedback insert failed:", err);
      return res.status(500).json({ error: "Failed to save feedback" });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("Feedback proxy error:", e);
    return res.status(500).json({ error: "Server error" });
  }
}
