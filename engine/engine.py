"""
ShadowScore Detection Engine
Core streaming detection logic — no external ML dependencies required.
"""

import math
import time
from collections import deque, defaultdict
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple


# ─────────────────────────────────────────────
#  Config
# ─────────────────────────────────────────────
EWMA_ALPHA       = 0.3          # smoothing factor for behavioral baseline
BURST_WINDOW_SEC = 60           # window in seconds for burst detection
BURST_THRESHOLD  = 5            # txns within window = burst
COORD_WINDOW_SEC = 120          # coordination sync window
COORD_THRESHOLD  = 0.6          # edge weight to flag coordination
STATE_HISTORY    = 200          # max txn history per entity
SCORE_CRIT       = 70
SCORE_HIGH       = 50
SCORE_ELEVATED   = 30

# Pre-defined fraud rings (clusters) — in production, learn these dynamically
CLUSTERS = {
    "A": ["ACC-1001", "ACC-1002", "ACC-1003"],
    "B": ["ACC-2001", "ACC-2002", "ACC-2004"],
    "C": ["ACC-3001", "ACC-3005", "ACC-3009"],
}


# ─────────────────────────────────────────────
#  Data classes
# ─────────────────────────────────────────────
@dataclass
class Transaction:
    txn_id:    str
    sender:    str
    receiver:  str
    amount:    float
    timestamp: float = field(default_factory=time.time)


@dataclass
class EntityState:
    entity_id:      str
    txn_count:      int    = 0
    total_amount:   float  = 0.0
    ewma_amount:    float  = 0.0      # exponential weighted moving average
    ewma_rate:      float  = 0.0      # txns per minute EWMA
    last_seen:      float  = 0.0
    drift_score:    float  = 0.0
    burst_score:    float  = 0.0
    coord_score:    float  = 0.0
    entropy_score:  float  = 0.0
    shadow_score:   float  = 0.0
    alert_level:    str    = "LOW"
    history:        deque  = field(default_factory=lambda: deque(maxlen=STATE_HISTORY))
    intervals:      deque  = field(default_factory=lambda: deque(maxlen=50))
    neighbors:      Dict   = field(default_factory=dict)


@dataclass
class Alert:
    entity_id:   str
    shadow_score: float
    level:       str
    drift:       float
    burst:       float
    coord:       float
    entropy:     float
    timestamp:   float
    reason:      str


# ─────────────────────────────────────────────
#  Engine
# ─────────────────────────────────────────────
class ShadowScoreEngine:
    def __init__(self):
        self.states:  Dict[str, EntityState] = {}
        self.alerts:  List[Alert]            = []
        self.edges:   Dict[Tuple, float]     = defaultdict(float)   # edge weights
        self.txn_log: List[dict]             = []
        self._entity_cluster: Dict[str, str] = {}

        # Build reverse-lookup: entity → cluster
        for cid, members in CLUSTERS.items():
            for m in members:
                self._entity_cluster[m] = cid

    # ── Public API ──────────────────────────────
    def process(self, txn: Transaction) -> dict:
        """Main entry point. Returns enriched transaction with score."""
        for entity_id in [txn.sender, txn.receiver]:
            if entity_id not in self.states:
                self.states[entity_id] = EntityState(entity_id=entity_id)
            self._update_state(entity_id, txn)
            self._compute_shadow_score(entity_id)
            self._route_alert(entity_id)

        result = self._build_result(txn)
        self.txn_log.append(result)
        if len(self.txn_log) > 1000:
            self.txn_log.pop(0)
        return result

    def get_score(self, entity_id: str) -> Optional[dict]:
        if entity_id not in self.states:
            return None
        s = self.states[entity_id]
        return {
            "entity_id":    entity_id,
            "shadow_score": round(s.shadow_score, 2),
            "alert_level":  s.alert_level,
            "drift":        round(s.drift_score, 3),
            "burst":        round(s.burst_score, 3),
            "coord":        round(s.coord_score, 3),
            "entropy":      round(s.entropy_score, 3),
            "txn_count":    s.txn_count,
            "last_seen":    s.last_seen,
        }

    def get_all_scores(self) -> List[dict]:
        return [self.get_score(eid) for eid in self.states]

    def get_alerts(self, min_level: str = "ELEVATED") -> List[dict]:
        levels = {"LOW": 0, "ELEVATED": 1, "HIGH": 2, "CRITICAL": 3}
        threshold = levels.get(min_level, 1)
        return [
            {
                "entity_id":    a.entity_id,
                "shadow_score": round(a.shadow_score, 2),
                "level":        a.level,
                "drift":        round(a.drift, 3),
                "burst":        round(a.burst, 3),
                "coord":        round(a.coord, 3),
                "entropy":      round(a.entropy, 3),
                "timestamp":    a.timestamp,
                "reason":       a.reason,
            }
            for a in self.alerts
            if levels.get(a.level, 0) >= threshold
        ]

    def get_edge_graph(self) -> dict:
        """Return coordination graph for visualisation."""
        nodes, edges = [], []
        for eid, state in self.states.items():
            nodes.append({
                "id":           eid,
                "score":        round(state.shadow_score, 2),
                "level":        state.alert_level,
                "cluster":      self._entity_cluster.get(eid, "none"),
            })
        for (u, v), w in self.edges.items():
            if w > 0.1:
                edges.append({"source": u, "target": v, "weight": round(w, 3)})
        return {"nodes": nodes, "edges": edges}

    def inject_fraud_burst(self, cluster_id: str = "A") -> List[dict]:
        """Simulate coordinated fraud wave for demo / testing."""
        members = CLUSTERS.get(cluster_id, CLUSTERS["A"])
        results = []
        now = time.time()
        for i, sender in enumerate(members):
            for j in range(4):   # 4 rapid txns per entity
                txn = Transaction(
                    txn_id=f"FRAUD-{cluster_id}-{sender}-{j}",
                    sender=sender,
                    receiver=f"MULE-{cluster_id}",
                    amount=round(9800 + (i * 37) + (j * 13), 2),   # just under reporting threshold
                    timestamp=now + (j * 4),   # 4-second bursts
                )
                results.append(self.process(txn))
        return results

    # ── Internal state update ────────────────────
    def _update_state(self, entity_id: str, txn: Transaction):
        s = self.states[entity_id]
        now = txn.timestamp

        # Record interval since last txn
        if s.last_seen > 0:
            interval = now - s.last_seen
            s.intervals.append(interval)

        # Update counters
        s.txn_count    += 1
        s.total_amount += txn.amount
        s.last_seen     = now
        s.history.append({"amount": txn.amount, "ts": now})

        # EWMA on amount
        if s.ewma_amount == 0.0:
            s.ewma_amount = txn.amount
        else:
            s.ewma_amount = EWMA_ALPHA * txn.amount + (1 - EWMA_ALPHA) * s.ewma_amount

        # EWMA on rate (txns per minute)
        if len(s.intervals) > 0:
            avg_interval = sum(s.intervals) / len(s.intervals)
            current_rate = 60.0 / max(avg_interval, 0.1)
        else:
            current_rate = 1.0
        if s.ewma_rate == 0.0:
            s.ewma_rate = current_rate
        else:
            s.ewma_rate = EWMA_ALPHA * current_rate + (1 - EWMA_ALPHA) * s.ewma_rate

        # Update edge weights
        other = txn.receiver if entity_id == txn.sender else txn.sender
        edge_key = tuple(sorted([entity_id, other]))
        self.edges[edge_key] = min(self.edges[edge_key] + 0.15, 1.0)
        s.neighbors[other] = s.neighbors.get(other, 0) + 1

    # ── Signal computation ───────────────────────
    def _compute_drift(self, s: EntityState) -> float:
        """How far current behavior deviates from personal baseline."""
        if s.txn_count < 3 or len(s.history) < 3:
            return 0.0
        recent = list(s.history)[-5:]
        recent_avg = sum(r["amount"] for r in recent) / len(recent)
        amount_drift = abs(recent_avg - s.ewma_amount) / max(s.ewma_amount, 1.0)

        # Frequency drift
        if len(s.intervals) >= 2:
            recent_intervals = list(s.intervals)[-5:]
            recent_rate = 60.0 / max(sum(recent_intervals) / len(recent_intervals), 0.1)
            rate_drift = abs(recent_rate - s.ewma_rate) / max(s.ewma_rate, 0.1)
        else:
            rate_drift = 0.0

        return min((amount_drift * 0.6 + rate_drift * 0.4), 5.0)

    def _compute_burst(self, s: EntityState, now: float) -> float:
        """Count txns in short time window, normalised."""
        window_txns = [r for r in s.history if now - r["ts"] <= BURST_WINDOW_SEC]
        count = len(window_txns)
        if count < BURST_THRESHOLD:
            return 0.0
        return min((count - BURST_THRESHOLD) / 5.0, 3.0)

    def _compute_coord(self, entity_id: str, now: float) -> float:
        """Detect synchronised activity within known clusters."""
        cluster_id = self._entity_cluster.get(entity_id)
        if not cluster_id:
            return 0.0
        members = CLUSTERS[cluster_id]
        sync_scores = []
        for peer in members:
            if peer == entity_id or peer not in self.states:
                continue
            peer_state = self.states[peer]
            if peer_state.last_seen == 0:
                continue
            time_diff = abs(now - peer_state.last_seen)
            if time_diff < COORD_WINDOW_SEC:
                sync_score = 1.0 - (time_diff / COORD_WINDOW_SEC)
                sync_scores.append(sync_score)
        return min(sum(sync_scores) / max(len(members) - 1, 1), 1.0) * 2.0

    def _compute_entropy(self, s: EntityState) -> float:
        """Low entropy = suspicious regularity in intervals (structuring)."""
        if len(s.intervals) < 5:
            return 0.0
        intervals = list(s.intervals)[-20:]
        mean = sum(intervals) / len(intervals)
        variance = sum((x - mean) ** 2 for x in intervals) / len(intervals)
        std = math.sqrt(max(variance, 0))
        cv = std / max(mean, 0.001)   # coefficient of variation
        # Very low CV = too regular = suspicious
        if cv < 0.05:
            return 2.0
        elif cv < 0.15:
            return 1.0
        return 0.0

    def _compute_shadow_score(self, entity_id: str):
        """Non-linear shadow score: interaction of all four signals."""
        s = self.states[entity_id]
        now = s.last_seen if s.last_seen > 0 else time.time()

        s.drift_score   = self._compute_drift(s)
        s.burst_score   = self._compute_burst(s, now)
        s.coord_score   = self._compute_coord(entity_id, now)
        s.entropy_score = self._compute_entropy(s)

        # Core non-linear formula
        base = (
            math.log1p(s.drift_score) *
            math.log1p(1 + s.burst_score) *
            math.log1p(1 + s.coord_score)
        )

        # Interaction amplifiers: when multiple signals converge
        amp = 1.0
        active_signals = sum([
            s.drift_score > 0.5,
            s.burst_score > 0.3,
            s.coord_score > 0.3,
            s.entropy_score > 0.5,
        ])
        if active_signals >= 3:
            amp = 2.5
        elif active_signals >= 2:
            amp = 1.6

        raw = base * amp + s.entropy_score * 0.3
        s.shadow_score = min(raw * 15, 99.0)

    def _route_alert(self, entity_id: str):
        s = self.states[entity_id]
        score = s.shadow_score

        if score >= SCORE_CRIT:
            level = "CRITICAL"
        elif score >= SCORE_HIGH:
            level = "HIGH"
        elif score >= SCORE_ELEVATED:
            level = "ELEVATED"
        else:
            level = "LOW"

        s.alert_level = level

        if level in ("HIGH", "CRITICAL"):
            reasons = []
            if s.drift_score > 0.5:
                reasons.append(f"behavioral drift={s.drift_score:.2f}")
            if s.burst_score > 0.3:
                reasons.append(f"burst={s.burst_score:.2f}")
            if s.coord_score > 0.3:
                reasons.append(f"coordination={s.coord_score:.2f}")
            if s.entropy_score > 0.5:
                reasons.append("suspicious regularity")

            alert = Alert(
                entity_id=entity_id,
                shadow_score=score,
                level=level,
                drift=s.drift_score,
                burst=s.burst_score,
                coord=s.coord_score,
                entropy=s.entropy_score,
                timestamp=time.time(),
                reason="; ".join(reasons) if reasons else "multi-signal convergence",
            )
            self.alerts.append(alert)
            if len(self.alerts) > 500:
                self.alerts.pop(0)

    def _build_result(self, txn: Transaction) -> dict:
        sender_state   = self.states.get(txn.sender)
        receiver_state = self.states.get(txn.receiver)
        return {
            "txn_id":        txn.txn_id,
            "sender":        txn.sender,
            "receiver":      txn.receiver,
            "amount":        txn.amount,
            "timestamp":     txn.timestamp,
            "sender_score":  round(sender_state.shadow_score, 2) if sender_state else 0,
            "receiver_score": round(receiver_state.shadow_score, 2) if receiver_state else 0,
            "sender_level":  sender_state.alert_level if sender_state else "LOW",
            "receiver_level": receiver_state.alert_level if receiver_state else "LOW",
            "max_score":     max(
                sender_state.shadow_score if sender_state else 0,
                receiver_state.shadow_score if receiver_state else 0,
            ),
        }


# ─────────────────────────────────────────────
#  Module-level singleton for API to import
# ─────────────────────────────────────────────
engine = ShadowScoreEngine()
