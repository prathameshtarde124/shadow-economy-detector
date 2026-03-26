"""
ShadowScore — Streamlit Dashboard
Real-time fraud detection visualisation. Connects to FastAPI backend.
Run: streamlit run dashboard/app.py
"""

import time
import random
import requests
import pandas as pd
import streamlit as st
from datetime import datetime

# ─────────────────────────────────────────────
#  Config
# ─────────────────────────────────────────────
API_BASE = "http://localhost:8000"
REFRESH_INTERVAL = 2   # seconds

st.set_page_config(
    page_title="ShadowScore · Fraud Detection",
    page_icon="🕵️",
    layout="wide",
    initial_sidebar_state="expanded",
)

# ─────────────────────────────────────────────
#  Helpers
# ─────────────────────────────────────────────
def safe_get(path: str, params: dict = None) -> dict:
    try:
        r = requests.get(f"{API_BASE}{path}", params=params, timeout=3)
        return r.json()
    except Exception as e:
        st.sidebar.error(f"API error: {e}")
        return {}

def safe_post(path: str, body: dict = None) -> dict:
    try:
        r = requests.post(f"{API_BASE}{path}", json=body or {}, timeout=5)
        return r.json()
    except Exception as e:
        st.sidebar.error(f"POST error: {e}")
        return {}

def level_color(level: str) -> str:
    return {
        "CRITICAL": "#FF4B4B",
        "HIGH":     "#FF8C00",
        "ELEVATED": "#FFD700",
        "LOW":      "#21C55D",
    }.get(level, "#888")

def score_bar(score: float) -> str:
    """Return HTML progress bar for shadow score."""
    pct  = min(score, 99)
    col  = "#FF4B4B" if score >= 70 else "#FF8C00" if score >= 50 else "#FFD700" if score >= 30 else "#21C55D"
    return (
        f'<div style="background:#222;border-radius:4px;height:8px;width:100%">'
        f'<div style="background:{col};border-radius:4px;height:8px;width:{pct}%"></div>'
        f'</div>'
    )


# ─────────────────────────────────────────────
#  Sidebar
# ─────────────────────────────────────────────
with st.sidebar:
    st.markdown("## 🕵️ ShadowScore")
    st.markdown("Real-time behavioral fraud detection")
    st.divider()

    st.markdown("### Inject fraud burst")
    cluster = st.selectbox("Cluster", ["A", "B", "C"])
    if st.button("⚡ Inject fraud burst", type="primary", use_container_width=True):
        result = safe_post("/inject-fraud", {"cluster_id": cluster})
        if result:
            st.success(f"Injected {result.get('injected', 0)} txns into cluster {cluster}")

    st.divider()

    st.markdown("### Submit test transaction")
    with st.form("txn_form"):
        sender   = st.text_input("Sender",   value="ACC-1001")
        receiver = st.text_input("Receiver", value="ACC-1002")
        amount   = st.number_input("Amount ($)", value=5000.0, min_value=1.0)
        submitted = st.form_submit_button("Send transaction")
    if submitted:
        result = safe_post("/transaction", {
            "sender": sender, "receiver": receiver, "amount": amount,
        })
        if result:
            score = result.get("max_score", 0)
            level = result.get("sender_level", "LOW")
            st.info(f"Score: **{score:.1f}** · Level: **{level}**")

    st.divider()
    st.markdown("### Filter")
    min_level = st.selectbox("Min alert level", ["ELEVATED", "HIGH", "CRITICAL"])
    auto_refresh = st.toggle("Auto-refresh", value=True)
    refresh_interval = st.slider("Refresh (s)", 1, 10, REFRESH_INTERVAL)


# ─────────────────────────────────────────────
#  Main content
# ─────────────────────────────────────────────
st.title("ShadowScore — Fraud Detection Dashboard")
st.caption(f"Last updated: {datetime.now().strftime('%H:%M:%S')}")

# ── Top KPI row ──────────────────────────────
scores_data = safe_get("/scores")
alerts_data = safe_get("/alerts", {"min_level": min_level})
txn_data    = safe_get("/txn-log", {"limit": 20})

all_scores  = scores_data.get("scores", [])
all_alerts  = alerts_data.get("alerts", [])
all_txns    = txn_data.get("transactions", [])

total_entities = len(all_scores)
critical_count = sum(1 for s in all_scores if s and s.get("alert_level") == "CRITICAL")
high_count     = sum(1 for s in all_scores if s and s.get("alert_level") == "HIGH")
avg_score      = (sum(s["shadow_score"] for s in all_scores if s) / max(total_entities, 1))

col1, col2, col3, col4, col5 = st.columns(5)
col1.metric("Tracked entities", total_entities)
col2.metric("🔴 Critical",  critical_count, delta=None)
col3.metric("🟠 High",       high_count,    delta=None)
col4.metric("Avg shadow score", f"{avg_score:.1f}")
col5.metric("Recent alerts",    len(all_alerts))

st.divider()

# ── Two-column layout ──────────────────────
left, right = st.columns([3, 2])

# ── Left: Transaction feed ───────────────
with left:
    st.subheader("📡 Live transaction feed")
    if all_txns:
        rows = []
        for t in all_txns[:15]:
            score = t.get("max_score", 0)
            level = t.get("sender_level", "LOW")
            rows.append({
                "Time":     datetime.fromtimestamp(t.get("timestamp", 0)).strftime("%H:%M:%S"),
                "Sender":   t.get("sender", ""),
                "Receiver": t.get("receiver", ""),
                "Amount":   f'${t.get("amount", 0):,.2f}',
                "Score":    round(score, 1),
                "Level":    level,
            })
        df = pd.DataFrame(rows)

        # Color rows by level
        def highlight(row):
            lvl = row["Level"]
            bg = {
                "CRITICAL": "background-color: rgba(255,75,75,0.18)",
                "HIGH":     "background-color: rgba(255,140,0,0.18)",
                "ELEVATED": "background-color: rgba(255,215,0,0.12)",
            }.get(lvl, "")
            return [bg] * len(row)

        st.dataframe(
            df.style.apply(highlight, axis=1),
            use_container_width=True,
            hide_index=True,
        )
    else:
        st.info("Waiting for transactions from the API…")

# ── Right: Alerts ────────────────────────
with right:
    st.subheader(f"🚨 Alerts ({min_level}+)")
    if all_alerts:
        for alert in all_alerts[:8]:
            level = alert.get("level", "LOW")
            color = level_color(level)
            score = alert.get("shadow_score", 0)
            with st.container():
                st.markdown(
                    f'<div style="border-left:4px solid {color};padding:8px 12px;'
                    f'background:rgba(255,255,255,0.03);border-radius:4px;margin-bottom:8px">'
                    f'<b style="color:{color}">{level}</b> &nbsp; '
                    f'<b>{alert.get("entity_id")}</b> &nbsp; score: {score:.1f}<br>'
                    f'<small style="color:#aaa">{alert.get("reason","")}</small><br>'
                    f'drift={alert.get("drift",0):.2f} &nbsp; '
                    f'burst={alert.get("burst",0):.2f} &nbsp; '
                    f'coord={alert.get("coord",0):.2f} &nbsp; '
                    f'entropy={alert.get("entropy",0):.2f}'
                    f'</div>',
                    unsafe_allow_html=True,
                )
    else:
        st.success("No alerts above threshold.")

st.divider()

# ── Entity score table ───────────────────
st.subheader("📊 Entity shadow scores")
if all_scores:
    score_rows = []
    for s in all_scores:
        if not s:
            continue
        score_rows.append({
            "Entity":    s.get("entity_id", ""),
            "Score":     round(s.get("shadow_score", 0), 1),
            "Level":     s.get("alert_level", "LOW"),
            "Drift":     round(s.get("drift", 0), 3),
            "Burst":     round(s.get("burst", 0), 3),
            "Coord":     round(s.get("coord", 0), 3),
            "Entropy":   round(s.get("entropy", 0), 3),
            "Txn count": s.get("txn_count", 0),
        })
    score_df = pd.DataFrame(score_rows).sort_values("Score", ascending=False)

    def color_score(val):
        if val >= 70: return "color: #FF4B4B; font-weight: bold"
        if val >= 50: return "color: #FF8C00"
        if val >= 30: return "color: #FFD700"
        return "color: #21C55D"

    st.dataframe(
        score_df.style.applymap(color_score, subset=["Score"]),
        use_container_width=True,
        hide_index=True,
    )
else:
    st.info("No entities tracked yet. Submit some transactions.")

st.divider()

# ── Signal breakdown chart ───────────────
st.subheader("📈 Signal breakdown (top 10 entities by score)")
if all_scores:
    top10 = [s for s in all_scores if s][:10]
    chart_data = pd.DataFrame({
        "Entity":  [s["entity_id"] for s in top10],
        "Drift":   [s["drift"]   for s in top10],
        "Burst":   [s["burst"]   for s in top10],
        "Coord":   [s["coord"]   for s in top10],
        "Entropy": [s["entropy"] for s in top10],
    }).set_index("Entity")
    st.bar_chart(chart_data, use_container_width=True)

st.divider()

# ── Coordination graph (text) ───────────
st.subheader("🕸️ Coordination graph")
graph_data = safe_get("/graph")
nodes = graph_data.get("nodes", [])
edges = graph_data.get("edges", [])

if nodes:
    st.markdown(f"**{len(nodes)} entities · {len(edges)} active edges**")
    edge_rows = [
        {
            "Source":  e.get("source"),
            "Target":  e.get("target"),
            "Weight":  e.get("weight"),
            "Risk":    "⚠️ High" if e.get("weight", 0) > 0.6 else "Normal",
        }
    ]
    if edge_rows and edges:
        st.dataframe(pd.DataFrame(edge_rows), use_container_width=True, hide_index=True)
    else:
        st.info("No significant coordination edges yet.")

# ── Auto-refresh ─────────────────────────
if auto_refresh:
    time.sleep(refresh_interval)
    st.rerun()
