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

  console.log("=== Searching for the follow-up message ===");
  const { data: messages, error } = await db
    .from("messages")
    .select("*, conversations(contact_id, contacts(phone, name))")
    .ilike("content_text", "%asked me remind you after 5 minutes%")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Error searching messages:", error);
    return;
  }

  if (!messages || messages.length === 0) {
    console.log("No matching messages found.");
    return;
  }

  for (const msg of messages) {
    console.log(`\nMessage ID: ${msg.id}`);
    console.log(`WhatsApp Message ID: ${msg.message_id}`);
    console.log(`Content: "${msg.content_text}"`);
    console.log(`Status: ${msg.status}`);
    console.log(`Sender: ${msg.sender_type}`);
    console.log(`Channel: ${msg.channel}`);
    console.log(`Created At: ${msg.created_at}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contact = (msg.conversations as any)?.contacts;
    console.log(`Recipient Phone: ${contact?.phone} (Name: ${contact?.name})`);
  }
}

main().catch(console.error);
