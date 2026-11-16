# Results

Everything here was measured on the deployed gateway
(`tollgate.iampdt.workers.dev`) on 16 November 2026, from a client in India routed to
Cloudflare's Chennai location. Raw output is in [`docs/data`](data). Each section says how
to run it again.

These are measurements of one deployment on one day on a free tier. They show how the
design behaves; they are not capacity figures.

## 1. Where the gateway's time goes

`POST /api/admin/latency` times each storage call the request path can make, from inside
the Worker, five times. Two runs:

| Call | Milliseconds (10 samples) |
| --- | --- |
| Cache API, miss | 2 – 4 |
| Cache API, hit | 2 – 3 |
| KV, key recently read | 1 – 2 |
| KV, miss | 172 – 275 |
| D1, one indexed read | 37 – 46 |
| Durable Object call (admit) | 40 – 55 |
| Durable Object call (breaker) | 37 – 67 |
| Embedding one prompt | 64 – 212 |
| Vectorize query | 213 – 238 |

Two decisions came straight from this table. The exact cache moved from KV to the Cache
API, because every uncached request was paying the 190 ms KV miss. And the three
independent checks (admission, exact cache, breaker) are made at once instead of in turn.

Gateway time before calling an upstream, single warm requests against the mock upstream
(a handful of samples each; the load test below is the larger measurement):

| Cache mode | Before | After |
| --- | --- | --- |
| Off | 85 – 128 ms | 43 – 54 ms |
| Exact, miss | 217 – 373 ms | 43 ms |
| Semantic, miss | 537 – 666 ms | 357 – 878 ms |

The semantic path did not get faster: embedding plus a vector query is about 300 ms
however it is arranged, and the judge can add more. It is opt-in for that reason.

## 2. Load test

`npm run loadtest` creates temporary keys, uses the mock upstream so no model quota is
spent, and deletes the keys afterwards.

```
No cache: 400 requests, 20 at a time, 400 answered, 170 requests/s
  seen by the client                 p50   86 ms   p95  242 ms   p99  580 ms
  inside the gateway                 p50   60 ms   p95  137 ms   p99  486 ms
  of which: rate limit and budget    p50   50 ms   p95  124 ms   p99  486 ms

Exact cache, every request a miss: 400 requests, 20 at a time, 400 answered, 182 requests/s
  seen by the client                 p50   85 ms   p95  205 ms   p99  490 ms
  inside the gateway                 p50   60 ms   p95  137 ms   p99  454 ms
  of which: rate limit and budget    p50   50 ms   p95  126 ms   p99  454 ms

Exact cache, every request a hit: 400 requests, 20 at a time, 400 answered, 227 requests/s
  seen by the client                 p50   81 ms   p95  121 ms   p99  146 ms
  inside the gateway                 p50   56 ms   p95   84 ms   p99  114 ms
  of which: rate limit and budget    p50   48 ms   p95   73 ms   p99  109 ms

Rate limit: 200 requests at once on a key limited to 50 per minute (burst took 0.8 s)
  answered 50, refused with 429 150, other 0
```

What this says:

- Admission is nearly all of the gateway's own latency. All 20 concurrent requests are on
  one key, so they queue on that key's one Durable Object; the tail is that queue.
- An exact miss costs nothing measurable over no cache at all.
- The limit is exact under a simultaneous burst.

The throughput figure is one key from one laptop, bounded by that single object and the
client. It is not the gateway's ceiling.

## 3. Semantic cache: does it return wrong answers?

`npm run eval:cache` sends 80 labelled pairs through both steps of the semantic cache:
40 rewordings of the same question, and 40 pairs that look alike and need different
answers (another city, another number, the opposite direction, a negation). The pairs are
in [`scripts/cache-pairs.json`](../scripts/cache-pairs.json).

Embedding model `bge-base-en-v1.5`, judge `llama-3.3-70b-instruct-fp8-fast`:

```
similarity of rewordings (40):          min 0.774  median 0.934  max 0.987
similarity of different questions (40): min 0.667  median 0.857  max 0.992

            threshold alone                with the judge
threshold   rewordings hit   wrong answers   rewordings hit   wrong answers
0.80        38 / 40          33 / 40          36 / 40           0 / 40
0.85        36 / 40          22 / 40          34 / 40           0 / 40
0.88        36 / 40          15 / 40          34 / 40           0 / 40
0.90        29 / 40           7 / 40          28 / 40           0 / 40
0.92        25 / 40           6 / 40          24 / 40           0 / 40
0.94        18 / 40           4 / 40          17 / 40           0 / 40
0.95        13 / 40           2 / 40          12 / 40           0 / 40
0.96         8 / 40           1 / 40           8 / 40           0 / 40
0.98         2 / 40           1 / 40           2 / 40           0 / 40
```

The two distributions overlap almost completely. The most similar *different* questions:

```
0.992  Convert 100 dollars to euros.  |  Convert 100 euros to dollars.
0.954  How do I reverse a string in JavaScript?  |  How do I reverse a string in Python?
0.946  When does the store open on Sunday?  |  When does the store close on Sunday?
0.944  Should I use Postgres for this?  |  Should I not use Postgres for this?
```

With the threshold alone there is no good setting: 0.92 still serves 6 wrong answers and
already loses 15 of the rewordings. With the judge, the threshold only decides how many
candidates are worth a judge call, and 0.85 keeps 34 rewordings with no wrong answer.

Of the 6 rewordings lost at 0.85: 4 were below the threshold, 1 was a judge call that gave
no verdict within 1.5 s, and 1 the judge turned down ("What is an API?" against "What does
API stand for and what is it?", which is arguably right).

The count of hits moves between runs, because a slow judge is a miss: an earlier run the
same day had four late verdicts and kept 31. The count of wrong answers was 0 in every run.

**Other embedding models did not fix it.** The best number of rewordings each could hit
while serving at most two wrong answers out of 40:

| Embedding model | Rewordings hit, at most 2 wrong | Any threshold with 0 wrong? |
| --- | --- | --- |
| `bge-base-en-v1.5` | 13 / 40 | no |
| `bge-large-en-v1.5` | 17 / 40 | no |
| `bge-m3` | 20 / 40 | no |
| `embeddinggemma-300m` | 13 / 40 | no |
| `qwen3-embedding-0.6b` | 6 / 40 | no |

**The judge has to be a capable model.** Judging all 80 pairs with no threshold:

| Judge | Rewordings accepted | Different questions wrongly accepted |
| --- | --- | --- |
| `llama-3.2-3b-instruct` | 38 / 40 | 8 / 40 |
| `llama-3.3-70b-instruct-fp8-fast` | 39 / 40 | 0 / 40 |

(Those two rows were judged without a time limit. With the 1.5 s limit the large judge
accepted 38 in the run shown above and 35 in the earlier one.)

**Limits of this evaluation.** Eighty pairs, written by me, English, single sentences. Zero
wrong answers in 40 is consistent with a true rate of several percent. It demonstrates the
failure of threshold-only matching and that a judge addresses it; it does not certify the
judge.

## 4. What the semantic cache costs in time

Twenty single calls of embedding plus judge, timed from the client: median 0.56 s, 17 of 20
under 0.7 s, slowest 1.9 s.

In the live demo a semantic hit took about 2.0 s end to end (embedding, vector query, a
cold KV read for the answer, and a slow judge call) and saved generating a 200-token answer. The
small Workers AI model that answered on that route then generated the same answer in 1.3 to
2 s; Groq, which leads the route now, is faster still.

So against a small, fast model the semantic cache saves tokens and not time. It earns its
latency in front of a slow or expensive model. An exact hit, by contrast, took 44 ms in the
same demo.

## 5. How long until a new answer is findable by meaning

Vectorize indexes inserts in the background. `scripts/index-delay.ts` inserts a vector
under a fresh scope and polls until a query finds it:

```
run 1: searchable after about 26 s
run 2: searchable after about 57 s
run 3: searchable after about 62 s
run 4: searchable after about 45 s
run 5: searchable after about 41 s
run 6: searchable after about 17 s
```

For up to a minute after an answer is first stored, a rewording of that question is a miss.
A repeat of the same wording is not affected: the exact cache is written at once.

## 6. Real providers through the gateway

`npx tsx scripts/providers.ts` sends real requests through every model the deployment has
credentials for, with caching off. Keys were set for Groq, Gemini and OpenAI; Workers AI
needs none. I ran it three times over one afternoon. The last run:

```
1. Each model, 8 requests one after another, same prompt, 80 tokens at most
   model                                              answered   first token (median)   whole answer (median)   tokens out (median)   streams
   workers-ai/llama-3.2-3b-instruct                   8 / 8      373 ms                 694 ms                  49                    yes
   workers-ai/llama-3.1-8b-instruct-fp8               8 / 8      467 ms                 2913 ms                 48                    yes
   workers-ai/llama-3.3-70b-instruct-fp8-fast         8 / 8      613 ms                 1513 ms                 46                    yes
   groq/openai/gpt-oss-20b                            8 / 8      960 ms                 1001 ms                 55                    yes
   groq/openai/gpt-oss-120b                           8 / 8      670 ms                 758 ms                  53                    yes
   gemini/gemini-3.5-flash-lite                       5 / 8      4287 ms                4435 ms                 39                    yes   first failure: gemini/gemini-3.5-flash-lite timeout
   openai/gpt-4.1-mini                                0 / 8      –                      –                       –                     no   first failure: openai/gpt-4.1-mini rate_limited (429)

2. Each route once: the upstreams it tried, in order
   fast     200  groq/openai/gpt-oss-20b ok
   smart    200  groq/openai/gpt-oss-120b ok
   gemini   200  gemini/gemini-3.5-flash-lite timeout → groq/openai/gpt-oss-120b ok
   premium  200  openai/gpt-4.1-mini rate_limited (429) → groq/openai/gpt-oss-120b ok

3. 24 requests at once on the "gemini" route (its first upstream is a free tier with its own rate limit)
   answered 24 / 24
     12 by groq/openai/gpt-oss-120b
     12 by gemini/gemini-3.5-flash-lite
     12 × gemini/gemini-3.5-flash-lite rate_limited
   median time to a whole answer: 2841 ms
```

Median time to a whole answer, per run:

| Model | Run 1 | Run 2 | Run 3 |
| --- | --- | --- | --- |
| Groq `gpt-oss-20b` | 513 ms | 682 ms | 1001 ms |
| Groq `gpt-oss-120b` | 584 ms | 507 ms | 758 ms |
| Workers AI `llama-3.2-3b-instruct` | 653 ms | 592 ms | 694 ms |
| Workers AI `llama-3.3-70b-instruct-fp8-fast` | 1321 ms | 1400 ms | 1513 ms |
| Gemini `gemini-3.5-flash-lite` | 1353 ms | 2901 ms | 4435 ms |
| Workers AI `llama-3.1-8b-instruct-fp8` | 3067 ms | 2780 ms | 2913 ms |

Between run 1 and run 2 Gemini's reasoning setting changed from "low" to "minimal" (see
below), so its three columns are not like for like; the other models were unchanged.

**Per model.** Groq and Workers AI's small model are the quickest, so they lead the `fast`
route, and Groq's larger model leads `smart`. Gemini's free tier was the slowest and the
least steady: in the last run 3 of its 8 requests produced no first token within 6 s.
The 8-billion-parameter model on Workers AI starts as quickly as the others and then
generates slowly, so it sits last.

**OpenAI answered nothing.** The account behind the key has no credit, and OpenAI refuses
each call with 429. The adapter, the request and the error handling are exercised; a
successful OpenAI completion is not. On the `premium` route that refusal is the first
attempt of every request, and Groq answers.

**The burst.** Twenty-four requests at once to a route whose first upstream is Gemini's free
tier. Across the three runs Gemini answered 8, 10 and 12 and refused the rest with "too many
requests" (plus one timeout). Each refused request moved to Groq and was answered there.
Callers saw 24 answers and no errors in every run; the median time to an answer was 1.1,
2.0 and 2.8 s.

**Four things mocks had not shown.**

- *Retired models.* Two model names in the catalog no longer existed. A 404 from an upstream
  now moves to the next one rather than failing the request.
- *A silent upstream.* In run 1 Gemini accepted a request and sent nothing; the caller
  waited the full first-token timeout, then 12 s. It is now 6 s.
- *An empty answer with status 200.* Groq's models think before answering, and the thinking
  counts against `max_tokens`. With a limit of 40 the reply was an empty string. Those
  models now get an allowance on top of the caller's limit, and any upstream that finishes
  without text is treated as failed.
- *The same from Gemini, differently.* With reasoning set to "low" and a limit of 200 it
  returned six tokens of answer. "none" is rejected for this model. "minimal" answers within
  the limit.

xAI and OpenRouter have no key on this deployment and were not exercised.
