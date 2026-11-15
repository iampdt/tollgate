// Measures how long the vector index takes to make a new entry searchable, which is how long
// a fresh answer stays invisible to the semantic cache.
//
//   TOLLGATE_URL=https://… ADMIN_TOKEN=… npx tsx scripts/index-delay.ts [runs]

const base = process.env.TOLLGATE_URL ?? "http://localhost:5173";
const token = process.env.ADMIN_TOKEN;
if (!token) throw new Error("Set ADMIN_TOKEN.");
const runs = Number(process.argv[2] ?? 5);

async function probe<T>(body: object): Promise<T> {
  const response = await fetch(`${base}/api/admin/index-probe`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

const delays: number[] = [];
for (let run = 0; run < runs; run++) {
  const { scope } = await probe<{ scope: string }>({ op: "insert" });
  const inserted = Date.now();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if ((await probe<{ found: boolean }>({ op: "query", scope })).found) break;
    if (Date.now() - inserted > 600_000) throw new Error("not searchable after 10 minutes");
  }
  delays.push(Math.round((Date.now() - inserted) / 1000));
  console.log(`run ${run + 1}: searchable after about ${delays.at(-1)} s`);
}
console.log(`\nmin ${Math.min(...delays)} s, max ${Math.max(...delays)} s (polled every 2 s)`);
export {};
