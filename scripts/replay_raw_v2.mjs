#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { replayRawV2 } from '../dist/index.js'
const file = process.argv[2]
if (!file) throw new Error('Usage: node scripts/replay_raw_v2.mjs INPUT.json')
const input = JSON.parse(readFileSync(file, 'utf8'))
process.stdout.write(`${JSON.stringify(await replayRawV2(input), null, 2)}\n`)
