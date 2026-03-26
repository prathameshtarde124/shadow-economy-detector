# ShadowScore — Real-time Fraud Detection System

Detects behaviorally-camouflaged fraud that evades static graph and rule-based systems.

---

## Architecture

```
Transaction input
      ↓
Ingestion layer  (HTTP POST / WebSocket / simulated stream)
      ↓
Streaming detection engine
  ├─ Node state tracker    (per-entity EWMA baseline)
  ├─ Drift engine          (behavioral deviation over time)
  ├─ Burst detector        (velocity spikes in time windows)
  └─ Coordination detector (cluster sync across accounts)
      ↓
Shadow score engine  (non-linear: log(drift)×log(burst)×log(coord) + amplifiers)
      ↓
Alert router  (LOW → ELEVATED → HIGH → CRITICAL)
      ↓
FastAPI layer  (REST + WebSocket)
      ↓
Streamlit dashboard  (live feed, charts, graph, alert inspector)
```

---

## Project structure

```
shadowscore/
├── engine/
│   └── engine.py          ← Core detection logic (no external ML deps)
├── api/
│   └── main.py            ← FastAPI: REST endpoints + WebSocket stream
├── dashboard/
│   └── app.py             ← Streamlit Dashboard
├── web_dashboard/         ← Premium Web Dashboard (matches screen.png)
│   ├── index.html
│   ├── style.css
│   └── app.js
├── tests/
│   └── test_engine.py
├── requirements.txt
└── README.md
```

---

## Quick start

### 1. Install dependencies

```bash
pip install -r requirements.txt
```

### 2. Run the API

```bash
cd api
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

The API auto-starts a background simulator that emits ~1 transaction/second
across 17 entities (3 fraud clusters + regular accounts).

### 3. Run the dashboard

```bash
cd dashboard
streamlit run app.py
```

Open http://localhost:8501 in a browser.

---

## API reference

| Method | Endpoint              | Description                              |
|--------|-----------------------|------------------------------------------|
| POST   | /transaction          | Submit a transaction for scoring         |
| GET    | /score/{entity_id}    | Get shadow score for one entity          |
| GET    | /scores               | All entity scores, sorted by risk        |
| GET    | /alerts?min_level=X   | Filtered alerts (ELEVATED/HIGH/CRITICAL) |
| GET    | /graph                | Coordination graph (nodes + edge weights)|
| POST   | /inject-fraud         | Simulate coordinated fraud burst         |
| GET    | /txn-log?limit=N      | Recent transaction log                   |
| WS     | /stream               | WebSocket: live transaction events       |

### Example: submit a transaction

```bash
curl -X POST http://localhost:8000/transaction \
  -H "Content-Type: application/json" \
  -d '{"sender":"ACC-1001","receiver":"ACC-1002","amount":9800}'
```

### Example: inject fraud burst

```bash
curl -X POST http://localhost:8000/inject-fraud \
  -H "Content-Type: application/json" \
  -d '{"cluster_id":"A"}'
```

### Example: get score

```bash
curl http://localhost:8000/score/ACC-1001
```

---

## Shadow score formula

```python
base = log(1 + drift) × log(1 + burst) × log(1 + coord)

amplifier:
  3+ signals active → ×2.5
  2  signals active → ×1.6

shadow_score = (base × amplifier + entropy × 0.3) × 15   [capped at 99]
```

**Alert thresholds**

| Score  | Level    |
|--------|----------|
| 0–29   | LOW      |
| 30–49  | ELEVATED |
| 50–69  | HIGH     |
| 70–99  | CRITICAL |

No single threshold triggers an alert — convergence of multiple signals is required,
which prevents rule bypass by adversaries who isolate one behavioral dimension.

---

## Signals

### Behavioral drift
EWMA tracks each entity's baseline amount and transaction frequency.
Drift = deviation of recent activity from personal baseline.
Catches slow-moving, camouflaged changes that burst detectors miss.

### Burst index
Counts transactions within a 60-second rolling window.
Normalised above a threshold of 5 txns/minute.

### Coordination score
Compares timing between members of pre-defined clusters.
Entities synchronising within 120 seconds receive elevated coordination weight.
Even low-score entities amplify each other when acting together.

### Temporal entropy
Low coefficient-of-variation in inter-transaction intervals = suspicious regularity.
Structuring attacks (distributing amounts to stay under reporting thresholds)
often create unnaturally regular spacing.

---

## Run tests

```bash
python tests/test_engine.py
# or
python -m pytest tests/ -v
```

All tests run against the engine directly — no running server required.

---

## Pain points addressed

| Pain point                                 | Solution                                           |
|--------------------------------------------|----------------------------------------------------|
| Static graphs miss distributed fraud       | Per-entity rolling state, no static graph needed   |
| Rule-based systems are predictable/bypass  | Non-linear formula with interaction amplifiers     |
| High false positive rates                  | Graduated levels, multi-signal convergence required|
| No temporal analysis                       | EWMA drift tracked continuously per entity         |
