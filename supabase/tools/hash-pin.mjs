#!/usr/bin/env node
// Generates the value for the EDITOR_PIN_HASH secret, so the PIN itself is never stored anywhere.
//   node supabase/tools/hash-pin.mjs            (prompts for the PIN; nothing is echoed or saved)
// Then:  supabase secrets set EDITOR_PIN_HASH='<printed value>'
import { pbkdf2Sync, randomBytes } from "node:crypto";
import readline from "node:readline";

const ITER = 210000;
const b64u = (b) => Buffer.from(b).toString("base64url");

function ask(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(q)) rl.output.write(s); };      // hide what is typed
    rl.question(q, (a) => { rl.close(); process.stdout.write("\n"); resolve(a); });
  });
}

const pin = process.env.PIN_INPUT ?? await ask("New numeric PIN (4-8 digits): ");
if (!/^\d{4,8}$/.test(pin)) { console.error("The PIN must be 4 to 8 digits."); process.exit(1); }
if (!process.env.PIN_INPUT) {
  const again = await ask("Repeat the PIN: ");
  if (again !== pin) { console.error("The two PINs do not match."); process.exit(1); }
}
const salt = randomBytes(16);
const hash = pbkdf2Sync(pin, salt, ITER, 32, "sha256");
console.log(`pbkdf2-sha256$${ITER}$${b64u(salt)}$${b64u(hash)}`);
