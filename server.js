/**
 * FORGE Stitch Server — Render deployment
 *
 * Simple Express proxy between Android app and Stitch MCP API.
 * Auth: service account JSON via GOOGLE_APPLICATION_CREDENTIALS_JSON env var
 * Security: requests must include X-Forge-Key header matching FORGE_API_KEY env var
 *
 * One endpoint:
 *   POST /stitch  { tool, title?, projectId?, prompt?, deviceType?, selectedScreenIds?, screenId? }
 *   → calls stitch.googleapis.com/mcp
 *   → returns { projectId?, screenId?, htmlUrl?, screenshotUrl?, error? }
 */

const express = require("express");
const { GoogleAuth } = require("google-auth-library");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const FORGE_API_KEY = process.env.FORGE_API_KEY || "forge-dev-key";
const GCP_PROJECT = process.env.GCP_PROJECT || "forge-design";
const STITCH_URL = "https://stitch.googleapis.com/mcp";

// ── Auth — service account ────────────────────────────────────────────────────
// On Render: set GOOGLE_APPLICATION_CREDENTIALS_JSON to the full JSON service account key
let auth;
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
  auth = new GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
} else {
  // Local dev: uses gcloud / GOOGLE_APPLICATION_CREDENTIALS file
  auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
}

async function getToken() {
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error("No access token from service account");
  return token;
}

// ── Stitch API call ───────────────────────────────────────────────────────────
async function callStitch(toolName, toolArgs) {
  const token = await getToken();

  const body = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: { name: toolName, arguments: toolArgs },
  };

  console.log(`[FORGE] → ${toolName}`, JSON.stringify(toolArgs).slice(0, 100));

  const response = await fetch(STITCH_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "X-Goog-User-Project": GCP_PROJECT,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    timeout: 180000, // 3 minutes — Stitch takes 60-90s for screen generation
  });

  const raw = await response.text();
  console.log(`[FORGE] ← HTTP ${response.status}, ${raw.length} bytes`);
  console.log(`[FORGE] response: ${raw.slice(0, 500)}`);

  if (!response.ok) {
    throw new Error(`Stitch HTTP ${response.status}: ${raw.slice(0, 200)}`);
  }

  return JSON.parse(raw);
}

// ── Parse helpers ─────────────────────────────────────────────────────────────
function getText(rpc) {
  return rpc?.result?.content?.[0]?.text || null;
}

function parseScreen(text, projectId) {
  if (!text) return { error: "empty Stitch response", projectId };
  try {
    const data = JSON.parse(text);
    // Format: outputComponents[].design.screens[0]
    if (Array.isArray(data.outputComponents)) {
      for (const comp of data.outputComponents) {
        const screens = comp?.design?.screens;
        if (screens?.length) {
          const s = screens[0];
          return {
            screenId: s.id || s.screenId,
            projectId,
            htmlUrl: s.htmlCode?.downloadUrl || null,
            screenshotUrl: s.screenshot?.downloadUrl || null,
            description: s.title || null,
            error: null,
          };
        }
      }
    }
    // Fallback: direct fields
    return {
      screenId: data.id || data.screenId || `sc_${Date.now()}`,
      projectId: data.projectId || projectId,
      htmlUrl: data.htmlUrl || data.htmlCode?.downloadUrl || null,
      screenshotUrl: data.screenshotUrl || data.screenshot?.downloadUrl || null,
      description: data.title || null,
      error: null,
    };
  } catch {
    return { error: `parse failed: ${text.slice(0, 100)}`, projectId };
  }
}

// ── Middleware: API key check ─────────────────────────────────────────────────
app.use("/stitch", (req, res, next) => {
  const key = req.headers["x-forge-key"];
  if (key !== FORGE_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status: "ok", server: "forge-stitch" }));

// ── Main endpoint ─────────────────────────────────────────────────────────────
app.post("/stitch", async (req, res) => {
  const { tool, title, prompt, projectId, deviceType, selectedScreenIds, screenId } = req.body;

  if (!tool) return res.status(400).json({ error: "tool is required" });

  try {
    switch (tool) {

      case "create_project": {
        if (!title) return res.status(400).json({ error: "title required" });
        const rpc = await callStitch("create_project", { title });
        const text = getText(rpc);
        console.log("[FORGE] create_project text:", text?.slice(0, 300) || "NONE");

        let pid = null;
        if (text) {
          try {
            const data = JSON.parse(text);
            const name = data.name || data.projectId || data.id;
            pid = name?.includes("/") ? name.split("/").pop() : name;
          } catch {
            const m = text.match(/"name"\s*:\s*"([^"]+)"/);
            if (m) pid = m[1].includes("/") ? m[1].split("/").pop() : m[1];
          }
        }

        return res.json({
          projectId: pid || null,
          title,
          error: pid ? null : `No projectId. Stitch said: ${text?.slice(0, 150) || "empty"}`,
        });
      }

      case "generate_screen_from_text": {
        if (!prompt || !projectId) return res.status(400).json({ error: "prompt and projectId required" });
        const rpc = await callStitch("generate_screen_from_text", {
          projectId, prompt, deviceType: deviceType || "MOBILE",
        });
        return res.json(parseScreen(getText(rpc), projectId));
      }

      case "edit_screens": {
        if (!projectId || !selectedScreenIds?.length || !prompt) {
          return res.status(400).json({ error: "projectId, selectedScreenIds[], prompt required" });
        }
        const rpc = await callStitch("edit_screens", { projectId, selectedScreenIds, prompt });
        return res.json(parseScreen(getText(rpc), projectId));
      }

      case "list_screens": {
        if (!projectId) return res.status(400).json({ error: "projectId required" });
        const rpc = await callStitch("list_screens", { projectId });
        const text = getText(rpc);
        let screens = [];
        try { screens = JSON.parse(text || "{}").screens || []; } catch { /**/ }
        return res.json({ screens });
      }

      case "get_screen": {
        if (!projectId || !screenId) return res.status(400).json({ error: "projectId and screenId required" });
        const rpc = await callStitch("get_screen", { projectId, screenId });
        return res.json(parseScreen(getText(rpc), projectId));
      }

      default:
        return res.status(400).json({ error: `unknown tool: ${tool}` });
    }
  } catch (e) {
    console.error("[FORGE] Error:", e.message);
    return res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`FORGE Stitch Server running on port ${PORT}`);
  console.log(`GCP Project: ${GCP_PROJECT}`);
});
