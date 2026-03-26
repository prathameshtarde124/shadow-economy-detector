"""
ShadowScore — FastAPI Layer
Exposes the detection engine via REST + WebSocket.
"""

import asyncio
import time
import random
import uuid
from typing import List, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

import sys, os
# Add parent directory to path to allow importing from 'engine'
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from engine.engine import engine, Transaction, CLUSTERS


# ─────────────────────────────────────────────
#  App setup
# ─────────────────────────────────────────────
app = FastAPI(
    title="ShadowScore Fraud Detection API",
    version="1.0.0",
    description="Real-time streaming fraud detection via behavioral drift, burst, and coordination signals.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# WebSocket connection manager
class ConnectionManager:
    def __init__(self):
        self.active: List[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active.append(ws)

    def disconnect(self, ws: WebSocket):
        if ws in self.active:
            self.active.remove(ws)

    async def broadcast(self, data: dict):
        dead = []
        for ws in self.active:
            try:
                await ws.send_json(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)

manager = ConnectionManager()


# ─────────────────────────────────────────────
#  Pydantic models
# ─────────────────────────────────────────────
class TxnRequest(BaseModel):
    txn_id:    Optional[str]   = Field(default_factory=lambda: str(uuid.uuid4())[:8])
    sender:    str
    receiver:  str
    amount:    float           = Field(..., gt=0)
    timestamp: Optional[float] = Field(default_factory=time.time)


class FraudBurstRequest(BaseModel):
    cluster_id: str = "A"


# ─────────────────────────────────────────────
#  Routes
# ─────────────────────────────────────────────
@app.get("/")
async def root():
    return {
        "service": "ShadowScore Fraud Detection",
        "version": "1.0.0",
        "endpoints": [
            "POST /transaction",
            "GET  /score/{entity_id}",
            "GET  /scores",
            "GET  /alerts",
            "GET  /graph",
            "POST /inject-fraud",
            "WS   /stream",
        ],
    }


@app.post("/transaction")
async def post_transaction(req: TxnRequest):
    """Submit a transaction for real-time scoring."""
    txn = Transaction(
        txn_id=req.txn_id,
        sender=req.sender,
        receiver=req.receiver,
        amount=req.amount,
        timestamp=req.timestamp or time.time(),
    )
    result = engine.process(txn)
    # Broadcast to WebSocket clients
    await manager.broadcast({"type": "txn", "data": result})
    return result


@app.get("/score/{entity_id}")
async def get_score(entity_id: str):
    """Fetch current shadow score for a specific entity."""
    score = engine.get_score(entity_id)
    if score is None:
        return {"error": f"Entity '{entity_id}' not found", "entity_id": entity_id}
    return score


@app.get("/scores")
async def get_all_scores():
    """Return scores for all tracked entities."""
    scores = engine.get_all_scores()
    return {
        "count":  len(scores),
        "scores": sorted(scores, key=lambda x: -(x["shadow_score"] if x else 0)),
    }


@app.get("/alerts")
async def get_alerts(min_level: str = "ELEVATED"):
    """Return all alerts at or above the specified level."""
    alerts = engine.get_alerts(min_level=min_level)
    return {
        "count":  len(alerts),
        "alerts": sorted(alerts, key=lambda x: -x["shadow_score"]),
    }


@app.get("/graph")
async def get_graph():
    """Return coordination graph for visualisation."""
    return engine.get_edge_graph()


@app.post("/inject-fraud")
async def inject_fraud(req: FraudBurstRequest):
    """Inject a simulated fraud burst for testing/demo."""
    results = engine.inject_fraud_burst(req.cluster_id)
    for r in results:
        await manager.broadcast({"type": "txn", "data": r})
    return {
        "injected":    len(results),
        "cluster":     req.cluster_id,
        "description": f"Coordinated burst across cluster {req.cluster_id}",
        "results":     results,
    }


@app.get("/txn-log")
async def get_txn_log(limit: int = 50):
    """Return recent transaction log."""
    log = engine.txn_log[-limit:]
    return {"count": len(log), "transactions": list(reversed(log))}


# ─────────────────────────────────────────────
#  Simulation Control
# ─────────────────────────────────────────────
SIM_RUNNING = True

@app.post("/toggle-simulation")
async def toggle_sim():
    """Toggle the background simulator on/off."""
    global SIM_RUNNING
    SIM_RUNNING = not SIM_RUNNING
    return {"running": SIM_RUNNING}

ALL_ENTITIES = (
    [f"ACC-{1000+i}" for i in range(1, 4)]  # cluster A
    + [f"ACC-{2000+i}" for i in [1, 2, 4]]  # cluster B
    + [f"ACC-{3000+i}" for i in [1, 5, 9]]  # cluster C
    + [f"ACC-REG-{i}"  for i in range(1, 8)] # regular
)

async def _simulate():
    """Continuously emit simulated transactions."""
    while True:
        if not SIM_RUNNING:
            await asyncio.sleep(1.0)
            continue

        sender   = random.choice(ALL_ENTITIES)
        receiver = random.choice([e for e in ALL_ENTITIES if e != sender])
        amount   = round(random.lognormvariate(7, 1.2), 2)
        txn = Transaction(
            txn_id=str(uuid.uuid4())[:8],
            sender=sender,
            receiver=receiver,
            amount=amount,
        )
        result = engine.process(txn)
        await manager.broadcast({"type": "txn", "data": result})
        await asyncio.sleep(random.uniform(0.4, 1.2))


@app.on_event("startup")
async def startup():
    asyncio.create_task(_simulate())


# ─────────────────────────────────────────────
#  Entry point
# ─────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8001, reload=True)
