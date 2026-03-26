"""
ShadowScore — Engine Tests
Run: python -m pytest tests/ -v
"""

import time
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from engine.engine import ShadowScoreEngine, Transaction, CLUSTERS


def make_engine():
    return ShadowScoreEngine()


# ─── Basic processing ───────────────────────────────────────────
def test_process_returns_result():
    eng = make_engine()
    txn = Transaction("t1", "ACC-A", "ACC-B", 100.0)
    result = eng.process(txn)
    assert result["sender"]    == "ACC-A"
    assert result["receiver"]  == "ACC-B"
    assert result["max_score"] >= 0


def test_entity_state_created():
    eng = make_engine()
    txn = Transaction("t1", "ACC-A", "ACC-B", 100.0)
    eng.process(txn)
    assert "ACC-A" in eng.states
    assert "ACC-B" in eng.states


def test_txn_count_increments():
    eng = make_engine()
    for i in range(5):
        eng.process(Transaction(f"t{i}", "ACC-A", "ACC-B", 100.0))
    assert eng.states["ACC-A"].txn_count == 5


# ─── Scoring ────────────────────────────────────────────────────
def test_score_range():
    eng = make_engine()
    for i in range(20):
        eng.process(Transaction(f"t{i}", "ACC-A", "ACC-B", 100.0 + i))
    score = eng.states["ACC-A"].shadow_score
    assert 0 <= score <= 99


def test_low_activity_low_score():
    eng = make_engine()
    eng.process(Transaction("t1", "ACC-CLEAN", "ACC-B", 100.0))
    score = eng.get_score("ACC-CLEAN")
    assert score is not None
    assert score["shadow_score"] < 30   # single txn = low score


def test_burst_raises_score():
    eng = make_engine()
    # Send many rapid txns
    now = time.time()
    for i in range(10):
        txn = Transaction(f"t{i}", "ACC-A", "ACC-B", 5000.0)
        txn.timestamp = now + i   # 1-second apart = burst
        eng.process(txn)
    score = eng.states["ACC-A"].shadow_score
    assert score > 0   # burst should register


# ─── Fraud burst injection ───────────────────────────────────────
def test_inject_fraud_burst_returns_results():
    eng = make_engine()
    results = eng.inject_fraud_burst("A")
    assert len(results) > 0


def test_inject_fraud_raises_cluster_scores():
    eng = make_engine()
    eng.inject_fraud_burst("A")
    members = CLUSTERS["A"]
    for member in members:
        score = eng.get_score(member)
        assert score is not None


# ─── Alert routing ──────────────────────────────────────────────
def test_alerts_empty_initially():
    eng = make_engine()
    alerts = eng.get_alerts()
    assert isinstance(alerts, list)


def test_get_score_unknown_entity():
    eng = make_engine()
    score = eng.get_score("DOES-NOT-EXIST")
    assert score is None


# ─── Graph ───────────────────────────────────────────────────────
def test_graph_structure():
    eng = make_engine()
    eng.process(Transaction("t1", "ACC-A", "ACC-B", 100.0))
    graph = eng.get_edge_graph()
    assert "nodes" in graph
    assert "edges" in graph
    assert len(graph["nodes"]) == 2


def test_all_scores_returns_list():
    eng = make_engine()
    eng.process(Transaction("t1", "ACC-A", "ACC-B", 100.0))
    scores = eng.get_all_scores()
    assert isinstance(scores, list)
    assert len(scores) == 2


# ─── EWMA update ────────────────────────────────────────────────
def test_ewma_updates():
    eng = make_engine()
    eng.process(Transaction("t1", "ACC-A", "ACC-B", 100.0))
    before = eng.states["ACC-A"].ewma_amount
    eng.process(Transaction("t2", "ACC-A", "ACC-B", 9000.0))
    after = eng.states["ACC-A"].ewma_amount
    assert after != before   # EWMA shifted toward 9000


if __name__ == "__main__":
    tests = [v for k, v in list(globals().items()) if k.startswith("test_")]
    passed = failed = 0
    for test in tests:
        try:
            test()
            print(f"  ✓  {test.__name__}")
            passed += 1
        except Exception as e:
            print(f"  ✗  {test.__name__} — {e}")
            failed += 1
    print(f"\n{passed} passed, {failed} failed")
