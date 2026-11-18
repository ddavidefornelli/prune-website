// Prints a fresh VAPID key pair for browser push. Run once, then:
//   supabase secrets set VAPID_PUBLIC_KEY=… VAPID_PRIVATE_KEY=… VAPID_SUBJECT=mailto:you@domain
//   and set VITE_VAPID_PUBLIC_KEY=… (same public key) for the website build.
// Rotating the pair silently invalidates every existing browser subscription.
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
console.log(`VAPID_PUBLIC_KEY=${b64url(raw)}`);
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`);
console.log(`VITE_VAPID_PUBLIC_KEY=${b64url(raw)}`);
