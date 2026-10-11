import type { Config, Context } from "@netlify/functions"
 
export default async (req: Request, context: Context) => {
  const secret = req.headers.get("x-telegram-bot-api-secret-token")
  const expected = Netlify.env.get("TELEGRAM_WEBHOOK_SECRET")
  if (!secret || !expected || !timingSafeEqual(secret, expected)) {
    return new Response("unauthorized", { status: 401 })
  }

  const update = await req.json()
  const msg = update.message ?? update.edited_message
  if (!msg) return new Response("ok")

  const username = msg.from?.username
  const text = msg.text ?? ""

  const roster = JSON.parse(Netlify.env.get("ROSTER_JSON") ?? "[]")
  const person = roster.find((p: any) => p.username === username)
  if (!person?.authorized) {
    await sendMessage(msg.chat.id, "Sorry, you're not on the authorized list.")
    return new Response("ok")
  }

  console.log(JSON.stringify({
    timestamp: new Date(msg.date * 1000).toISOString(),
    sender: person.name,
    username,
    chat_id: msg.chat.id,
    text: text.slice(0, 200),
    intent: "unclassified",
    outcome: "received",
  }))

  await sendMessage(msg.chat.id, `Got it, ${person.name}. Message logged.`)
  return new Response("ok")
}

async function sendMessage(chatId: number, text: string) {
  const token = Netlify.env.get("TELEGRAM_BOT_TOKEN")
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  })
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let out = 0
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return out === 0
}

export const config: Config = { path: "/telegram-gateway" } 
