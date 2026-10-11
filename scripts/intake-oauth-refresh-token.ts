// One-time helper Chris runs on his own computer to get the Google refresh token
// (drive.file scope only). Nothing is stored; the token is printed once to this
// terminal so Chris can paste it into Netlify as GOOGLE_OAUTH_REFRESH_TOKEN.
//
//   GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... npm run intake:oauth
//
// The OAuth client must be of type "Desktop app" (loopback redirect).
import { createServer } from "node:http"
import { randomBytes } from "node:crypto"
import { DRIVE_FILE_SCOPE } from "../lib/intake/google"

const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
if (!clientId || !clientSecret) {
  console.error("Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET first.")
  process.exit(1)
}

const state = randomBytes(16).toString("hex")
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1")
  if (url.pathname !== "/callback") { res.writeHead(404).end(); return }
  if (url.searchParams.get("state") !== state) { res.writeHead(400).end("State mismatch."); return }
  const code = url.searchParams.get("code")
  if (!code) { res.writeHead(400).end(`No code: ${url.searchParams.get("error") ?? "unknown"}`); return }
  const port = (server.address() as { port: number }).port
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: clientId, client_secret: clientSecret,
      redirect_uri: `http://127.0.0.1:${port}/callback`, grant_type: "authorization_code",
    }),
  })
  const json = (await tokenRes.json()) as { refresh_token?: string; scope?: string; error?: string }
  if (!json.refresh_token) {
    res.writeHead(500).end("No refresh token returned. See the terminal.")
    console.error(`Google did not return a refresh token (${json.error ?? "no error code"}). Remove the app's access at https://myaccount.google.com/permissions and run this again.`)
  } else {
    res.writeHead(200, { "content-type": "text/plain" }).end("Done. You can close this tab and go back to the terminal.")
    console.log("\nGranted scope:", json.scope)
    console.log("\nGOOGLE_OAUTH_REFRESH_TOKEN (paste into Netlify, mark it secret, then clear this terminal):\n")
    console.log(json.refresh_token)
  }
  server.close()
})

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port
  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth")
  auth.search = new URLSearchParams({
    client_id: clientId, redirect_uri: `http://127.0.0.1:${port}/callback`, response_type: "code",
    scope: DRIVE_FILE_SCOPE, access_type: "offline", prompt: "consent", state,
  }).toString()
  console.log("Open this link in your browser, sign in as yourself and approve:\n")
  console.log(auth.toString())
})
