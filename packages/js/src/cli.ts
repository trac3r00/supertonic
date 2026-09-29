#!/usr/bin/env node
import { roundSampleCount } from "./index.js"

const [command, value] = process.argv.slice(2)
if (command === "round-samples" && value !== undefined) {
  console.log(JSON.stringify({ samples: roundSampleCount(Number(value)) }))
} else {
  console.error("usage: supertonic-runtime-js round-samples <value>")
  process.exitCode = 2
}
