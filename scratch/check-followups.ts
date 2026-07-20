import { supabaseAdmin } from "../src/lib/ai/admin-client";
import * as fs from "fs";
import * as path from "path";

// Load .env.local manually
try {
  const envPath = path.join(process.cwd(), ".env.local");
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf8");
    for (const line of envContent.split("\n")) {
      const match = line.match(/^\s*([^#=]+)\s*=\s*(.*)\s*$/);
      if (match) {
        const key = match[1].trim();
        let value = match[2].trim();
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
        process.env[key] = value;
      }
    }
  }
} catch (e) {
  console.error("Failed to load .env.local", e);
}

async function main() {
  const db = supabaseAdmin();

  console.log("=== Fetching Recent Follow-ups ===");
  const { data: followUps, error } = await db
    .from("follow_ups")
    .select("*, contacts(name, phone)")
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) {
    console.error("Error fetching follow-ups:", error);
    return;
  }

  if (!followUps || followUps.length === 0) {
    console.log("No follow-ups found.");
    return;
  }

  for (const f of followUps) {
    console.log(`\nFollow-up ID: ${f.id}`);
    console.log(`Contact: ${(f.contacts as any)?.name} (${(f.contacts as any)?.phone})`);
    console.log(`Task Description: "${f.task_description}"`);
    console.log(`Status: ${f.status}`);
    console.log(`Scheduled At: ${f.scheduled_at}`);
    console.log(`Completed At: ${f.completed_at}`);
    console.log(`Error Message: ${f.error_message}`);
  }
}

main().catch(console.error);
