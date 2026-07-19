async function checkLlamaModels() {
  const res = await fetch('https://openrouter.ai/api/v1/models')
  const json = await res.json()
  const llamaModels = json.data.filter((m: any) => m.id.includes('llama-3.2'))
  console.log('Found Llama 3.2 models:', llamaModels.map((m: any) => m.id))
}
checkLlamaModels()
