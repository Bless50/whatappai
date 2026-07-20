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
  const conversationId = "5df13831-533c-43d4-b532-10a07273263d";

  console.log(`=== Inspecting messages for conversation ${conversationId} ===`);
  const { data: messages, error } = await db
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) {
    console.error("Error fetching messages:", error);
    return;
  }

  for (const m of messages || []) {
    console.log(`[${m.created_at}] ${m.sender_type.toUpperCase()} (${m.content_type}): "${m.content_text?.substring(0, 60)}..."`);
    console.log(`  Status: ${m.status}, message_id: ${m.message_id}, channel: ${m.channel}`);
  }
}

main().catch(console.error);
