import { resolve } from "node:path"
import { DataVerificationError, verifyDataDirectory } from "./data-integrity.js"

const directory = resolve(process.argv[2] ?? "dist/data")

try {
  await verifyDataDirectory(directory)
  console.log(JSON.stringify({ verified: true, directory }))
} catch (error: unknown) {
  if (error instanceof DataVerificationError || error instanceof Error) {
    console.error(error.message)
    process.exitCode = 1
  } else {
    throw error
  }
}
