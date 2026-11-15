// Runs labelled prompt pairs through both steps of the semantic cache on a deployed gateway
// and reports how many rewordings would hit (good) and how many different questions would
// be served each other's answer (bad): with the similarity threshold alone, and with the
// judge behind it.
//
//   TOLLGATE_URL=https://… ADMIN_TOKEN=… npm run eval:cache

import { readFileSync } from "node:fs";

const base = process.env.TOLLGATE_URL ?? "http://localhost:5173";
const token = process.env.ADMIN_TOKEN;
if (!token) throw new Error("Set ADMIN_TOKEN.");

type Pair = [string, string];
interface Scored {
  embedder: string;
  judge: string | null;
  scores: number[];
  verdicts: ("accepted" | "rejected" | "timeout")[] | null;
}
const pairs = JSON.parse(readFileSync(new URL("./cache-pairs.json", import.meta.url), "utf8")) as { same: Pair[]; different: Pair[] };

async function run(all: Pair[]): Promise<Scored> {
  const out: Scored = { embedder: "", judge: null, scores: [], verdicts: [] };
  for (let i = 0; i < all.length; i += 5) {
    const response = await fetch(`${base}/api/admin/similarity`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ pairs: all.slice(i, i + 5), judge: true }),
    });
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    const batch = (await response.json()) as Scored;
    out.embedder = batch.embedder;
    out.judge = batch.judge;
    out.scores.push(...batch.scores);
    if (batch.verdicts && out.verdicts) out.verdicts.push(...batch.verdicts);
    else out.verdicts = null;
  }
  return out;
}

const same = await run(pairs.same);
const different = await run(pairs.different);
const range = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return `min ${sorted[0]?.toFixed(3)}  median ${sorted[Math.floor(sorted.length / 2)]?.toFixed(3)}  max ${sorted.at(-1)?.toFixed(3)}`;
};
const count = (set: Scored, threshold: number, judged: boolean) =>
  set.scores.filter((score, i) => score >= threshold && (!judged || set.verdicts?.[i] === "accepted")).length;
const cell = (n: number, of: number) => `${String(n).padStart(2)} / ${of}`;

console.log(`embedder: ${same.embedder}\njudge:    ${same.judge ?? "none"}\n`);
console.log(`similarity of rewordings (${pairs.same.length}):          ${range(same.scores)}`);
console.log(`similarity of different questions (${pairs.different.length}): ${range(different.scores)}\n`);
console.log("            threshold alone                with the judge");
console.log("threshold   rewordings hit   wrong answers   rewordings hit   wrong answers");
for (const threshold of [0.8, 0.85, 0.88, 0.9, 0.92, 0.94, 0.95, 0.96, 0.98]) {
  const row = [cell(count(same, threshold, false), pairs.same.length), cell(count(different, threshold, false), pairs.different.length)];
  if (same.verdicts) row.push(cell(count(same, threshold, true), pairs.same.length), cell(count(different, threshold, true), pairs.different.length));
  console.log(`${threshold.toFixed(2)}        ${row.join("          ")}`);
}
if (same.verdicts && different.verdicts) {
  console.log(`\njudge alone: accepted ${same.verdicts.filter((v) => v === "accepted").length} / ${pairs.same.length} rewordings, ${different.verdicts.filter((v) => v === "accepted").length} / ${pairs.different.length} different questions`);
  const turnedDown = pairs.same.map((pair, i) => [...pair, same.verdicts?.[i] ?? ""]).filter((row) => row[2] !== "accepted");
  if (turnedDown.length) console.log("rewordings the judge turned down:\n" + turnedDown.map((p) => `  ${p[2] === "timeout" ? "(no verdict in time) " : ""}${p[0]}  |  ${p[1]}`).join("\n"));
  const letThrough = pairs.different.filter((_, i) => different.verdicts?.[i] === "accepted");
  if (letThrough.length) console.log("different questions the judge let through:\n" + letThrough.map((p) => `  ${p[0]}  |  ${p[1]}`).join("\n"));
}
const closest = pairs.different.map((pair, i) => ({ pair, score: different.scores[i] ?? 0 })).sort((a, b) => b.score - a.score).slice(0, 5);
console.log("\nmost similar different questions:");
for (const { pair, score } of closest) console.log(`  ${score.toFixed(3)}  ${pair[0]}  |  ${pair[1]}`);
