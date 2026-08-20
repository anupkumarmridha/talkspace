const {
  createIdentity, deriveSharedKey, encryptFor, decryptFrom,
  safetyNumber, dtlsFingerprint, EventChain,
} = await import("../public/js/e2ee.js");

let failures = 0;
const check = (n, ok, x = "") => { console.log(`${ok ? "  PASS" : "  FAIL"}  ${n}${x ? "  " + x : ""}`); if (!ok) failures++; };

console.log("\n== ECDH agreement ==");
const ada = await createIdentity();
const grace = await createIdentity();
const mallory = await createIdentity();
check("public keys are distinct", ada.pub !== grace.pub);
check("P-256 raw key is 65 bytes", Buffer.from(ada.pub, "base64url").length === 65);

const kA = await deriveSharedKey(ada, grace.pub);   // Ada's view
const kB = await deriveSharedKey(grace, ada.pub);   // Grace's view
const kM = await deriveSharedKey(mallory, ada.pub); // eavesdropper's view

console.log("\n== round trip ==");
const box = await encryptFor(kA, { fromId: "ada", toId: "grace", seq: 0, text: "meet at six 🕕" });
check("ciphertext is not the plaintext", !Buffer.from(box.ct, "base64url").toString().includes("meet"));
const out = await decryptFrom(kB, { fromId: "ada", toId: "grace", seq: 0, ...box });
check("recipient recovers plaintext", out === "meet at six 🕕", JSON.stringify(out));

console.log("\n== authenticated associated data ==");
check("wrong key fails", (await decryptFrom(kM, { fromId: "ada", toId: "grace", seq: 0, ...box })) === null);
check("replay to another recipient fails", (await decryptFrom(kB, { fromId: "ada", toId: "eve", seq: 0, ...box })) === null);
check("re-attributed sender fails", (await decryptFrom(kB, { fromId: "eve", toId: "grace", seq: 0, ...box })) === null);
check("relabelled sequence fails", (await decryptFrom(kB, { ...box, fromId: "ada", toId: "grace", seq: 1 })) === null);

const flipped = Buffer.from(box.ct, "base64url");
flipped[3] ^= 0x01;
check("single flipped bit fails", (await decryptFrom(kB, {
  fromId: "ada", toId: "grace", seq: 0, iv: box.iv, ct: flipped.toString("base64url"),
})) === null);

console.log("\n== nonce hygiene ==");
const ivs = new Set();
for (let i = 0; i < 200; i++) ivs.add((await encryptFor(kA, { fromId: "a", toId: "b", seq: i, text: "x" })).iv);
check("IV never repeats across 200 messages", ivs.size === 200);

console.log("\n== safety number ==");
const roster = [
  { id: "ada", pub: ada.pub, dtls: "AA:BB" },
  { id: "grace", pub: grace.pub, dtls: "CC:DD" },
];
const s1 = await safetyNumber("rm1", roster);
const s2 = await safetyNumber("rm1", [...roster].reverse());
check("independent of participant order", s1.digits === s2.digits, s1.digits);
check("renders 5 emoji", s1.emoji.split(" ").length === 5, s1.emoji);

const swapped = await safetyNumber("rm1", [roster[0], { id: "grace", pub: mallory.pub, dtls: "CC:DD" }]);
check("a swapped public key changes it", swapped.digits !== s1.digits);

const mediaMitm = await safetyNumber("rm1", [roster[0], { ...roster[1], dtls: "EE:FF" }]);
check("a swapped DTLS fingerprint changes it", mediaMitm.digits !== s1.digits);
check("a different room changes it", (await safetyNumber("rm2", roster)).digits !== s1.digits);

// Deliberately NOT history-dependent. Each participant sees a different
// sequence of local events, so mixing that in would give everyone a
// different number and there would be nothing to compare out loud.
check(
  "identical rosters agree regardless of local history",
  (await safetyNumber("rm1", roster)).digits === s1.digits,
);

console.log("\n== dtls parsing ==");
check("extracts fingerprint from SDP",
  dtlsFingerprint("v=0\r\na=fingerprint:sha-256 AB:CD:EF\r\na=setup:actpass") === "ab:cd:ef");
check("absent fingerprint yields empty string", dtlsFingerprint("v=0") === "");

console.log("\n== hash chain ==");
const c1 = new EventChain(), c2 = new EventChain();
for (const ev of [["join", { id: "ada" }], ["join", { id: "grace" }], ["dtls", { fp: "ab" }]]) {
  await c1.append(...ev); await c2.append(...ev);
}
check("identical histories converge", c1.head === c2.head, c1.shortHead);

const c3 = new EventChain();
await c3.append("join", { id: "ada" });
await c3.append("join", { id: "mallory" });
await c3.append("dtls", { fp: "ab" });
check("a divergent history is detectable", c3.head !== c1.head);

const before = c1.head;
await c1.append("join", { id: "late" });
check("head advances on append", c1.head !== before);
check("entries are retained", c1.entries.length === 4);

console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILURE(S)"}\n`);
process.exit(failures ? 1 : 0);
