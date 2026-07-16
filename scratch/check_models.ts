async function main() {
  const res = await fetch('https://openrouter.ai/api/v1/models');
  if (!res.ok) {
    console.error('Failed to fetch models:', res.statusText);
    return;
  }
  const json = await res.json();
  const visionModels = json.data.filter((m: any) => 
    m.id.toLowerCase().includes('gemini') || 
    m.id.toLowerCase().includes('vision')
  );
  console.log('--- VISION MODELS ---');
  visionModels.forEach((m: any) => {
    console.log(`- ${m.id} (${m.name})`);
  });
}

main().catch(console.error);
