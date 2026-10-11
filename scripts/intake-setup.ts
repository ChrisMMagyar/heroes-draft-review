// One-time bootstrap Chris runs by hand (spec 6.2, 7). It creates, as the drive.file
// app, the intake folders and the "Telegram Intake Log" Sheet, then prints the env var
// values to paste into Netlify. Safe to re-run: it reuses folders/sheets it already made.
//
//   GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... GOOGLE_OAUTH_REFRESH_TOKEN=... \
//     npm run intake:setup            # add -- --dry-run to only print the plan
//
// Note: under drive.file the app cannot create files inside folders it didn't create
// (Google answers 404 for the parent), so everything is created at the top of My Drive.
// Afterwards Chris drags each folder to its home (spec 7). Moving keeps the app's access.
import { createGoogle } from "../lib/intake/google"
import { CHANGE_REQUESTS_TAB, CHANGE_REQUEST_COLUMNS, DAILY_COLUMNS, DAILY_TAB, INTAKE_COLUMNS, INTAKE_TAB } from "../lib/intake/sheet"
import { HOLD_FOLDER_NAME } from "../lib/intake/worker"

export const SHARED_FOLDER = "Telegram Gateway (Shared Process)"
export const UNSORTED_FOLDER = "Intake — Unsorted"
export const LOG_SHEET = "Telegram Intake Log"
export const PROJECT_FOLDERS = [
  { env: "DRIVE_FOLDER_HEROES", name: "Heroes Photo Intake — Telegram", moveTo: "Heroes Martial Arts Academy — Website" },
  { env: "DRIVE_FOLDER_TFC", name: "TFC Photo Intake — Telegram", moveTo: "The Firearms Concierge (top)" },
  { env: "DRIVE_FOLDER_KRAKEN", name: "Kraken Photo Intake — Telegram", moveTo: "Kraken Combatives (top)" },
] as const

const dryRun = process.argv.includes("--dry-run")

async function main() {
  const { GOOGLE_OAUTH_CLIENT_ID: clientId, GOOGLE_OAUTH_CLIENT_SECRET: clientSecret, GOOGLE_OAUTH_REFRESH_TOKEN: refreshToken } = process.env
  if (dryRun) {
    console.log("Dry run. Would create (or reuse) at the top of My Drive:")
    for (const p of PROJECT_FOLDERS) console.log(`  ${p.name}/  with  ${HOLD_FOLDER_NAME}/`)
    console.log(`  ${SHARED_FOLDER}/  with  ${UNSORTED_FOLDER}/ (+ ${HOLD_FOLDER_NAME}/) and the Sheet "${LOG_SHEET}" (tabs ${INTAKE_TAB}, ${DAILY_TAB}, ${CHANGE_REQUESTS_TAB})`)
    return
  }
  if (!clientId || !clientSecret || !refreshToken) {
    console.error("Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET and GOOGLE_OAUTH_REFRESH_TOKEN first.")
    process.exit(1)
  }
  const google = createGoogle({ clientId, clientSecret, refreshToken })
  const folder = async (name: string, parent = "root") =>
    (await google.findChild(parent, name, true)) ?? (await google.createFolder(name, parent === "root" ? undefined : parent))

  const out: Record<string, string> = {}
  for (const p of PROJECT_FOLDERS) {
    const id = await folder(p.name)
    await folder(HOLD_FOLDER_NAME, id)
    out[p.env] = id
  }
  const shared = await folder(SHARED_FOLDER)
  const unsorted = await folder(UNSORTED_FOLDER, shared)
  await folder(HOLD_FOLDER_NAME, unsorted)
  out.DRIVE_FOLDER_UNSORTED = unsorted

  let sheet = await google.findChild(shared, LOG_SHEET)
  if (!sheet) {
    sheet = await google.createSpreadsheet(LOG_SHEET, [
      { title: INTAKE_TAB, headers: [...INTAKE_COLUMNS] },
      { title: DAILY_TAB, headers: [...DAILY_COLUMNS] },
      { title: CHANGE_REQUESTS_TAB, headers: [...CHANGE_REQUEST_COLUMNS] },
    ])
    await google.moveToFolder(sheet, shared)
  }
  out.INTAKE_LOG_SHEET_ID = sheet

  console.log("\nDone. Add these to Netlify (site heroes-draft-review, Functions scope):\n")
  for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`)
  console.log("\nThen, in Google Drive, drag each folder to its home (the app keeps access after a move):")
  for (const p of PROJECT_FOLDERS) console.log(`  "${p.name}"  ->  ${p.moveTo}`)
  console.log(`  "${SHARED_FOLDER}" stays at the top of My Drive (spec 7).`)
  console.log("Do not share these folders or the Sheet with anyone.")
}

main().catch((e) => {
  console.error(`Setup failed: ${e instanceof Error ? e.message : "unknown error"}`)
  process.exit(1)
})
