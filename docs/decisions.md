# Decisions

The choices that shaped the system, what they cost, and what I would revisit.

## 1. Cloudflare Workers, not a server

**Why.** The brief was "completely free". A gateway is mostly waiting on other people's
servers, which is what Workers charge least for: the free plan limits CPU time (10 ms per
request), not wall time. The platform also brings the pieces a gateway needs, each with a
free tier: Durable Objects for exact counters, a cache at the edge, a vector index, and
models that need no API key.

**Cost.** The 10 ms CPU budget rules out anything heavy in the request path, which is why
statistics are computed in SQL. Everything is tied to one vendor's bindings; the provider
and cache interfaces are the seams if that had to change.

## 2. Limits in a Durable Object per key

**Why.** A rate limit kept in a shared key-value store is a read, a decision and a write,
and two requests can interleave. A Durable Object handles one call at a time, so the limit
is exact with no locking. The load test sent 200 requests at once to a 50-per-minute key and
exactly 50 were answered.

**Cost.** About 45 ms per request, measured: the round trip to wherever the object lives.
It is the largest part of the gateway's own latency. The alternative is approximate
counting inside each Worker isolate, which is free and fast and lets a burst through. For
a component whose job is to enforce a budget I chose exact.

**Would revisit.** One key under very high concurrency queues on its one object (the 95th
percentile in the load test was 129 ms for this step). Sharding a key across several
objects with a slice of the limit each would trade exactness for throughput.

## 3. Three checks at once

Admission, the exact cache and the breaker state are independent, so they are asked
together. Taken one after another they cost 85 to 235 ms; together they cost the slowest of
them, about 45 ms.

**Cost.** A refused request has still read the cache and may have been handed the one test
of a half-open upstream. The test lease expires after 20 seconds, so the worst case is one
delayed recovery check. The expensive lookup, the semantic one, still waits for admission:
a refused request never spends an embedding.

## 4. Exact cache per location, not global

**Why.** I started with the global key-value store. A diagnostic endpoint that times each
storage call from inside the Worker showed a miss there costs about 190 ms, on every
uncached request. The Cache API at the same location answered in 3 ms, hit or miss.

**Cost.** A repeat only hits if it reaches the same Cloudflare location. For callers that
are servers in fixed places that is nearly always true; for a global consumer app the hit
rate would drop. The semantic cache stays global, because it is opt-in and already slow.

## 5. A judge behind the semantic cache

**Why.** Measured, not assumed: see [results](results.md). At any threshold that let most
rewordings hit, the embedding also matched questions with different answers, and four
other embedding models did no better. Asking a model "would a correct answer to A also
answer B?" removed every wrong answer in the test set.

**Cost.** One more model call per candidate match, about half a second and occasionally
much longer, so the judge has a 1.5 s limit after which the request is a miss. The judge has
to see the earlier prompt, so semantic entries store the prompt text in KV for the life of
the entry. Traces still store none.

**The small model was not enough.** A 3-billion-parameter judge wrongly accepted 8 of the 40
different questions. The 70-billion one accepted none. The judge is the wrong place to save
money.

## 6. Fall back until the first token, not after

Once a caller has received part of an answer, replacing the upstream means either
restarting the answer (the caller now has two beginnings) or splicing a second model's text
onto the first's. Both are worse than stopping. A broken stream ends with an error event
and without `[DONE]`.

A non-streaming request has sent nothing, so it can be retried on the next upstream even
after a failure half-way through.

## 7. A rejected request is not retried elsewhere

If an upstream answers 400, the next one almost certainly will too, and each attempt costs
quota. The one case this gets wrong is a prompt too long for a small model that a larger
one would have accepted. I would handle that by knowing each model's context length up
front rather than by retrying on 400.

## 8. Count tokens after the answer, not before

The budget check asks "has this key already used its tokens today?", not "will this request
fit?". Reserving an estimate up front would be stricter but needs a guess at the answer's
length and a refund path. The cost is that a key can overshoot by whatever is in flight
when the budget runs out.

## 9. A mock provider in production

`mock/echo`, `mock/fail-503`, `mock/timeout` and the rest are in the deployed catalog. They
cost nothing to call, which makes three things possible: tests that drive real failure
paths end to end, a load test that measures the gateway rather than a model, and a public
demo where a visitor can watch a provider fail. The canned reply is never cached.

## 10. No prompt text in traces

A trace is for answering "what happened to this request?", and that never needs the text.
Leaving it out removes the question of who may read traces. A test stores a request
containing a marker string and asserts the marker is nowhere in the stored row.
