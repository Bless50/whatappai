import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })

const gatewayUrl = 'http://localhost:3001'
const accountId = 'c7583d8d-1360-4502-8775-eb8e9e8b1a06'

async function run() {
  console.log(`Requesting session connect for account ${accountId}...`)
  try {
    const res = await fetch(`${gatewayUrl}/api/session/connect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ accountId }),
    })
    console.log('Status Code:', res.status)
    const json = await res.json()
    console.log('Response:', JSON.stringify(json, null, 2))
  } catch (err) {
    console.error('Fetch error:', err)
  }
}

run()
