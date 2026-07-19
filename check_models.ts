async function checkModels() {
  const res = await fetch('https://openrouter.ai/api/v1/models')
  const json = await res.json()
  const deepseekModels = json.data.filter((m: any) => m.id.includes('deepseek'))
  console.log(deepseekModels.map((m: any) => m.id))
}
checkModels()
