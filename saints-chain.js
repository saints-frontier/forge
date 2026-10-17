// The Saints' on-chain helpers for the deploy pages (browser ES module). Everything a page reads goes to the public Sui
// testnet GraphQL endpoint; everything that changes the chain is a transaction the pilot signs in EVE Vault. No key is
// ever held here. SDK versions pinned (released at least two weeks before 2026-10-17).
import { Transaction } from "https://cdn.jsdelivr.net/npm/@mysten/sui@2.33.2/transactions/+esm";
import { SuiGraphQLClient } from "https://cdn.jsdelivr.net/npm/@mysten/sui@2.33.2/graphql/+esm";
import { getWallets } from "https://cdn.jsdelivr.net/npm/@mysten/wallet-standard@0.21.31/+esm";
import { deriveObjectID } from "https://cdn.jsdelivr.net/npm/@mysten/sui@2.33.2/utils/+esm";
import { bcs } from "https://cdn.jsdelivr.net/npm/@mysten/sui@2.33.2/bcs/+esm";

export { Transaction };
export const GQL = "https://graphql.testnet.sui.io/graphql";
export const CHAIN = "sui:testnet";
// EVE Frontier, Stillness (Cycle 7): the world package (original id = published-at, version 1)
export const WORLD = "0x7be18d6294e533bedd9a5d70a96ce8d9d4b87a7c74188ba65d3fe966bbed9d92";
export const TURRET_T = `${WORLD}::turret::Turret`;
export const OWNERCAP_TURRET_T = `${WORLD}::access::OwnerCap<${TURRET_T}>`;
export const PROFILE_T = `${WORLD}::character::PlayerProfile`;
// the registry every in-game object id is derived from (object_registry::ObjectRegistry, shared; read 2026-10-17)
export const OBJECT_REGISTRY = "0x8fd47e6e5cf8cb9b789cef26fbb674be819d8abd6afccaf50e95451212f0813a";
export const TENANT = "stillness";

export const client = new SuiGraphQLClient({ url: GQL, network: "testnet" });

export async function gql(query, variables) {
  const r = await fetch(GQL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (j.errors && j.errors.length) throw new Error(j.errors.map(e => e.message).join("; "));
  return j.data;
}

// ---- reading -------------------------------------------------------------------------------------------------------
const OWNED = `query($a: SuiAddress!, $t: String!, $c: String) { address(address: $a) { objects(filter: {type: $t}, first: 50, after: $c) {
  pageInfo { hasNextPage endCursor } nodes { address contents { json } } } } }`;

async function ownedOfType(addr, type) {
  const out = []; let c = null;
  for (let i = 0; i < 20; i++) {
    const d = await gql(OWNED, { a: addr, t: type, c });
    const o = d.address && d.address.objects; if (!o) break;
    out.push(...o.nodes);
    if (!o.pageInfo.hasNextPage) break; c = o.pageInfo.endCursor;
  }
  return out;
}

export async function suiBalance(addr) {
  const d = await gql(`query($a: SuiAddress!) { address(address: $a) { balance(coinType: "0x2::sui::SUI") { totalBalance } } }`, { a: addr });
  return Number((d.address && d.address.balance && d.address.balance.totalBalance) || 0) / 1e9;
}

/** The EVE Frontier character of a wallet (its PlayerProfile points at it), or null. */
export async function characterOf(wallet) {
  const prof = await ownedOfType(wallet, PROFILE_T);
  if (!prof.length) return null;
  const id = prof[0].contents.json.character_id;
  const d = await gql(`query($a: SuiAddress!) { object(address: $a) { asMoveObject { contents { json } } } }`, { a: id });
  const j = d.object && d.object.asMoveObject && d.object.asMoveObject.contents.json;
  return j ? { id, tribe: Number(j.tribe_id), wallet: j.character_address, name: (j.metadata && j.metadata.name) || "" } : { id };
}

/** The turrets a character owns: its OwnerCap<Turret>s and the turrets they open. */
export async function turretsOf(characterId) {
  const caps = await ownedOfType(characterId, OWNERCAP_TURRET_T);
  if (!caps.length) return [];
  const ids = caps.map(c => c.contents.json.authorized_object_id);
  const d = await gql(`query($k: [ObjectKey!]!) { multiGetObjects(keys: $k) { address asMoveObject { contents { json } } } }`, { k: ids.map(address => ({ address })) });
  return d.multiGetObjects.map((o, i) => {
    if (!o || !o.asMoveObject) return null;                    // the key outlived its turret (taken down): skip it
    return { ...turretFields(ids[i], o.asMoveObject.contents.json || {}), ownerCap: caps[i].address };
  }).filter(Boolean);
}

function turretFields(id, j) {
  const ext = j.extension ? (typeof j.extension === "string" ? j.extension : j.extension.name || JSON.stringify(j.extension)) : null;
  const meta = j.metadata || {};
  return { id, typeId: j.type_id, itemId: j.key && j.key.item_id, name: meta.name || "", description: meta.description || "", url: meta.url || "",
    online: /online/i.test(JSON.stringify(j.status || "")), extension: ext, ownerCapId: j.owner_cap_id || null };
}

/** The chain id of an in-game object (its item id under the tenant), derived like the world package does. */
export function objectIdOf(itemId) {
  const key = bcs.struct("TenantItemId", { item_id: bcs.u64(), tenant: bcs.string() }).serialize({ item_id: String(itemId), tenant: TENANT }).toBytes();
  return deriveObjectID(OBJECT_REGISTRY, `${WORLD}::in_game_id::TenantItemId`, key);
}

/** One turret by its chain id, or null when it is not a turret (or gone). */
export async function turretById(id) {
  const d = await gql(`query($a: SuiAddress!) { object(address: $a) { asMoveObject { contents { type { repr } json } } } }`, { a: id });
  const c = d.object && d.object.asMoveObject && d.object.asMoveObject.contents;
  if (!c || !/::turret::Turret$/.test(c.type.repr)) return null;
  return turretFields(id, c.json || {});
}

// ---- the settings line (a copy of the Move parser in saints_turret::turret, for the preview) ---------------------
export function parseSettings(desc) {
  const s = { mode: "war", f: [], e: [], p: [], x: [], found: false };
  const t = String(desc || "").toLowerCase(), at = t.indexOf("[saints");
  if (at < 0) return s;
  s.found = true;
  const end = t.indexOf("]", at), body = t.slice(at + 7, end < 0 ? t.length : end);
  for (const tok of body.split(/[ \n\r\t|;]+/).filter(Boolean)) {
    if (tok === "war" || tok === "peace" || tok === "hold") { s.mode = tok; continue; }
    const m = tok.match(/^([fepx])=(.*)$/); if (!m) continue;
    for (const n of m[2].match(/\d+/g) || []) { const v = Number(n); if (v <= 4294967295 && s[m[1]].length < 64 && !s[m[1]].includes(v)) s[m[1]].push(v); }
  }
  return s;
}

// ---- EVE Vault (Wallet Standard) ------------------------------------------------------------------------------------
export function vault() {
  const all = getWallets().get();
  return all.find(w => /eve\s*vault/i.test(w.name)) || null;
}
/** Every wallet this browser offers that can sign Sui transactions (the game's own browser may name it differently). */
export function suiWallets() {
  return getWallets().get().filter(w => w.features && w.features["sui:signAndExecuteTransaction"]);
}
export async function connect(any = false) {
  const pick = () => vault() || (any ? suiWallets()[0] || null : null);
  let w = pick();
  if (!w) { await new Promise(r => setTimeout(r, 800)); w = pick(); }       // extensions register a moment after load
  if (!w) throw new Error("EVE Vault was not found in this browser. Install it, sign in, then reload this page.");
  const res = await w.features["standard:connect"].connect();
  const account = (res.accounts || w.accounts)[0];
  if (!account) throw new Error("EVE Vault gave no account.");
  return { wallet: w, account };
}
export async function signAndExecute({ wallet, account }, tx) {
  tx.setSenderIfNotSet(account.address);
  const f = wallet.features["sui:signAndExecuteTransaction"];
  if (!f) throw new Error("This wallet cannot sign and execute transactions.");
  return f.signAndExecuteTransaction({ transaction: tx, account, chain: CHAIN });
}

/** Try a transaction on the live chain without a signature and without gas (nothing is changed). */
export async function simulate(tx, sender) {
  tx.setSenderIfNotSet(sender);
  const r = await client.core.simulateTransaction({ transaction: tx, include: { effects: true, objectTypes: true }, checksEnabled: false });
  return r;
}

// ---- the transactions -----------------------------------------------------------------------------------------------
export function publishTx(bytecode, sender) {
  const tx = new Transaction();
  const [cap] = tx.publish({ modules: bytecode.modules, dependencies: bytecode.dependencies });
  tx.transferObjects([cap], tx.pure.address(sender));          // the update right stays in the publisher's own wallet
  return tx;
}
function withTurretCap(tx, characterId, ownerCapId, body) {
  const [cap, receipt] = tx.moveCall({ target: `${WORLD}::character::borrow_owner_cap`, typeArguments: [TURRET_T], arguments: [tx.object(characterId), tx.object(ownerCapId)] });
  body(cap);
  tx.moveCall({ target: `${WORLD}::character::return_owner_cap`, typeArguments: [TURRET_T], arguments: [tx.object(characterId), cap, receipt] });
}
/** The description an install writes: "[SAINTS peace]" in front when it has no settings line yet (user 2026-10-17:
 *  "default to peace mode when installing"); null = leave it as it is (it has a line, or the line would not fit the
 *  game's 100 characters). */
export function peaceOnInstall(desc) {
  const d = String(desc || "").trim();
  if (d.toLowerCase().includes("[saints")) return null;
  const text = d ? "[SAINTS peace] " + d : "[SAINTS peace]";
  return text.length <= 100 ? text : null;
}
export function installTx(pkg, characterId, turret) {
  const tx = new Transaction(), text = peaceOnInstall(turret.description);
  withTurretCap(tx, characterId, turret.ownerCap, cap => {
    tx.moveCall({ target: `${WORLD}::turret::authorize_extension`, typeArguments: [`${pkg}::turret::SaintsTurretAuth`], arguments: [tx.object(turret.id), cap] });
    if (text !== null) tx.moveCall({ target: `${WORLD}::turret::update_metadata_description`, arguments: [tx.object(turret.id), cap, tx.pure.string(text)] });
  });
  return tx;
}
/** Rewrite the turret's description (the owner's key, borrowed from the character for this one transaction). */
export function describeTx(characterId, turret, text) {
  const tx = new Transaction();
  withTurretCap(tx, characterId, turret.ownerCap, cap => tx.moveCall({ target: `${WORLD}::turret::update_metadata_description`, arguments: [tx.object(turret.id), cap, tx.pure.string(text)] }));
  return tx;
}
export function removeTx(characterId, turret) {
  const tx = new Transaction();
  withTurretCap(tx, characterId, turret.ownerCap, cap => tx.moveCall({ target: `${WORLD}::turret::revoke_extension_authorization`, arguments: [tx.object(turret.id), cap] }));
  return tx;
}
/** Is this turret running the Saints code of package `pkg`? (the stored type name omits or keeps the 0x) */
export function runsSaints(turret, pkg) {
  if (!turret.extension || !pkg) return false;
  const want = (pkg.replace(/^0x/, "") + "::turret::SaintsTurretAuth").toLowerCase();
  return turret.extension.replace(/^0x/, "").toLowerCase().endsWith(want);
}
