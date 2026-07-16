const clientKey = process.argv[2];
const clientSecret = process.argv[3];
const code = process.argv[4];

if (!clientKey || !clientSecret || !code) {
  console.error("Usage: node scratch/exchange.js <clientKey> <clientSecret> <code>");
  process.exit(1);
}

const url = "https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/";

console.log("Exchanging code for token...");

fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    client_key: clientKey,
    client_secret: clientSecret,
    code: code,
    grant_type: "authorization_code"
  })
})
  .then(res => res.json())
  .then(data => {
    console.log("Response:", JSON.stringify(data, null, 2));
  })
  .catch(err => {
    console.error("Error exchanging code:", err);
  });
