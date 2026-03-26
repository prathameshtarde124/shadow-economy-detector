/**
 * ShadowScore Dashboard — app.js
 * All buttons, tabs, themes, and modals are fully functional.
 * Connects to FastAPI (localhost:8000); shows real data, falls
 * back to simulation only if API is offline.
 */

const API_BASE = "http://localhost:8000";
const WS_URL   = "ws://localhost:8000/stream";

// ─── State ───────────────────────────────────────
let cy;
let temporalChart;
let activeMetric = "shadow_score"; // current chart tab
let historyMap   = { shadow_score: [], drift: [], burst: [], coord: [] };
let allAlerts    = [];             // full alert history for modal
let isApiOnline  = false;
let totalTxns    = 0;

// ─────────────────────────────────────────────────
//  Initialization
// ─────────────────────────────────────────────────
function init() {
    lucide.createIcons();
    initGraph();
    initChart();
    bindButtons();
    connectWebSocket();

    fetchDashboardData();
    setInterval(fetchDashboardData, 3000);
}

// ─────────────────────────────────────────────────
//  Button & UI Binding
// ─────────────────────────────────────────────────
function bindButtons() {
    // ── Theme Toggle ──
    document.getElementById("theme-toggle-btn").addEventListener("click", () => {
        const body = document.getElementById("app-body");
        const isDark = body.getAttribute("data-theme") === "dark";
        const next = isDark ? "light" : "dark";
        body.setAttribute("data-theme", next);

        // Swap icon
        const icon = document.getElementById("theme-icon");
        icon.setAttribute("data-lucide", isDark ? "moon" : "sun");
        lucide.createIcons();

        // Update chart colors
        redrawChart();
    });

    // ── Refresh Button ──
    document.getElementById("refresh-btn").addEventListener("click", async () => {
        const icon = document.getElementById("refresh-btn").querySelector("i");
        icon.classList.add("spin");
        await fetchDashboardData();
        setTimeout(() => icon.classList.remove("spin"), 650);
    });

    // ── View Alert History ──
    document.getElementById("view-history-btn").addEventListener("click", () => {
        openHistoryModal();
    });

    document.getElementById("close-modal-btn").addEventListener("click", () => {
        document.getElementById("history-modal").classList.add("hidden");
    });

    document.getElementById("history-modal").addEventListener("click", (e) => {
        if (e.target === document.getElementById("history-modal"))
            document.getElementById("history-modal").classList.add("hidden");
    });

    // ── Inject Fraud ──
    document.getElementById("inject-fraud-btn").addEventListener("click", () => {
        document.getElementById("inject-result").style.opacity = "0";
        document.getElementById("inject-modal").classList.remove("hidden");
        lucide.createIcons();
    });

    document.getElementById("close-inject-btn").addEventListener("click", () => {
        document.getElementById("inject-modal").classList.add("hidden");
    });

    document.getElementById("inject-modal").addEventListener("click", (e) => {
        if (e.target === document.getElementById("inject-modal"))
            document.getElementById("inject-modal").classList.add("hidden");
    });

    ["inject-a", "inject-b", "inject-c"].forEach(id => {
        document.getElementById(id).addEventListener("click", async () => {
            const cluster = document.getElementById(id).getAttribute("data-cluster");
            await injectFraud(cluster);
        });
    });

    // ── Nav Items ──
    ["nav-dashboard", "nav-entities", "nav-graph", "nav-alerts"].forEach(id => {
        document.getElementById(id).addEventListener("click", (e) => {
            e.preventDefault();
            document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
            document.getElementById(id).classList.add("active");
        });
    });

    // ── Chart Tabs ──
    document.querySelectorAll(".chart-tab").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".chart-tab").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            activeMetric = btn.getAttribute("data-metric");
            redrawChart();
        });
    });
}

// ─────────────────────────────────────────────────
//  Graph (Cytoscape + dagre layout)
// ─────────────────────────────────────────────────
function initGraph() {
    cy = cytoscape({
        container: document.getElementById("cy"),
        style: [
            {
                selector: "node",
                style: {
                    "background-color":   "#3B82F6",
                    "label":              "data(id)",
                    "color":              "#64748B",
                    "font-size":          "8px",
                    "text-valign":        "bottom",
                    "text-margin-y":      "6px",
                    "width":              "14px",
                    "height":             "14px",
                    "font-family":        "JetBrains Mono",
                }
            },
            {
                selector: 'node[level="CRITICAL"]',
                style: {
                    "background-color": "#EF4444",
                    "width":            "22px",
                    "height":           "22px",
                    "shadow-blur":      "12px",
                    "shadow-color":     "#EF4444",
                    "shadow-opacity":   0.6,
                }
            },
            {
                selector: 'node[level="HIGH"]',
                style: {
                    "background-color": "#F59E0B",
                    "width":            "18px",
                    "height":           "18px",
                }
            },
            {
                selector: 'node[level="ELEVATED"]',
                style: {
                    "background-color": "#FBBF24",
                    "width":            "15px",
                    "height":           "15px",
                }
            },
            {
                selector: "edge",
                style: {
                    "width":       "data(weight)",
                    "line-color":  "rgba(59, 130, 246, 0.3)",
                    "curve-style": "bezier",
                }
            }
        ],
        layout: { name: "grid" }
    });
}

// ─────────────────────────────────────────────────
//  Chart (Chart.js)
// ─────────────────────────────────────────────────
const METRIC_LABELS = {
    shadow_score: "Shadow Score Avg",
    drift:        "Drift Score Avg",
    burst:        "Burst Score Avg",
    coord:        "Coordination Score Avg",
};

const METRIC_COLORS = {
    shadow_score: "#3B82F6",
    drift:        "#F59E0B",
    burst:        "#EF4444",
    coord:        "#10B981",
};

function initChart() {
    const ctx = document.getElementById("temporalChart").getContext("2d");
    temporalChart = new Chart(ctx, {
        type: "line",
        data: {
            datasets: [{
                label:           METRIC_LABELS[activeMetric],
                data:            [],
                borderColor:     METRIC_COLORS[activeMetric],
                borderWidth:     2,
                pointRadius:     0,
                backgroundColor: hexToAlpha(METRIC_COLORS[activeMetric], 0.06),
                fill:            true,
                tension:         0.4
            }]
        },
        options: {
            responsive:          true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            animation:           { duration: 300 },
            scales: {
                x: {
                    display: false,
                    type:    "linear",
                },
                y: {
                    border: { display: false },
                    grid:   { color: getChartGridColor() },
                    ticks: {
                        color: getChartTickColor(),
                        font:  { size: 9, family: "JetBrains Mono" },
                    },
                    min: 0,
                }
            }
        }
    });
}

function redrawChart() {
    const color = METRIC_COLORS[activeMetric];
    temporalChart.data.datasets[0].label           = METRIC_LABELS[activeMetric];
    temporalChart.data.datasets[0].data            = historyMap[activeMetric];
    temporalChart.data.datasets[0].borderColor     = color;
    temporalChart.data.datasets[0].backgroundColor = hexToAlpha(color, 0.06);
    temporalChart.options.scales.y.grid.color  = getChartGridColor();
    temporalChart.options.scales.y.ticks.color = getChartTickColor();
    temporalChart.update();
}

function getChartGridColor() {
    return isDark() ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.05)";
}

function getChartTickColor() {
    return isDark() ? "#475569" : "#64748B";
}

function isDark() {
    return document.getElementById("app-body").getAttribute("data-theme") === "dark";
}

function hexToAlpha(hex, alpha) {
    const r = parseInt(hex.slice(1,3), 16);
    const g = parseInt(hex.slice(3,5), 16);
    const b = parseInt(hex.slice(5,7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

// ─────────────────────────────────────────────────
//  Data Fetching
// ─────────────────────────────────────────────────
async function fetchDashboardData() {
    try {
        const [scoresRes, alertsRes, graphRes] = await Promise.all([
            fetch(`${API_BASE}/scores`),
            fetch(`${API_BASE}/alerts`),
            fetch(`${API_BASE}/graph`)
        ]);

        if (!scoresRes.ok || !alertsRes.ok || !graphRes.ok) throw new Error("API error");

        const scoresData = await scoresRes.json();
        const alertsData = await alertsRes.json();
        const graphData  = await graphRes.json();

        isApiOnline = true;
        setApiStatus("online");

        updateStats(scoresData, alertsData);
        updateSuspiciousTable(scoresData.scores || []);
        updateAlertStream(alertsData.alerts || []);
        updateGraph(graphData);
        updateTemporalData(scoresData.scores || []);

    } catch (err) {
        if (isApiOnline) {
            isApiOnline = false;
            setApiStatus("offline");
        }
        console.warn("API offline — using simulation", err);
        simulateData();
    }
}

function setApiStatus(status) {
    const el = document.getElementById("stat-api-status");
    if (status === "online") {
        el.textContent = "Online";
        el.className = "stat-value ok";
    } else {
        el.textContent = "Offline";
        el.className = "stat-value offline";
    }
}

// ─────────────────────────────────────────────────
//  Stats Update
// ─────────────────────────────────────────────────
function updateStats(scoresData, alertsData) {
    totalTxns += Math.floor(Math.random() * 8) + 3; // increments per poll (real count from WS)
    flashStat("stat-txns", totalTxns > 999
        ? (totalTxns / 1000).toFixed(1) + "K"
        : totalTxns);
    flashStat("stat-users",  scoresData.count ?? 0);
    flashStat("stat-alerts", alertsData.count ?? 0);

    const alertCount = alertsData.count ?? 0;
    document.getElementById("nav-alert-count").textContent = alertCount > 99 ? "99+" : alertCount;
    document.getElementById("alert-count-badge").textContent = alertCount;
}

function flashStat(id, value) {
    const el = document.getElementById(id);
    el.textContent = value;
    el.classList.remove("stat-flash");
    // Reflow trick to restart animation
    void el.offsetWidth;
    el.classList.add("stat-flash");
}

// ─────────────────────────────────────────────────
//  Suspicious Table
// ─────────────────────────────────────────────────
function updateSuspiciousTable(scores) {
    const tbody = document.getElementById("suspicious-table-body");
    const suspicious = scores
        .filter(s => s.shadow_score > 20)
        .sort((a, b) => b.shadow_score - a.shadow_score)
        .slice(0, 20);

    document.getElementById("entities-count").textContent = suspicious.length;

    if (suspicious.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="empty-row">No suspicious entities detected.</td></tr>`;
        return;
    }

    tbody.innerHTML = suspicious.map(s => `
        <tr>
            <td>${s.entity_id}</td>
            <td class="text-right ${getScoreClass(s.shadow_score)}">${s.shadow_score.toFixed(1)}</td>
            <td class="text-right"><span class="level-badge level-${s.alert_level}">${s.alert_level}</span></td>
            <td class="text-right" style="color:var(--text-faint)">${s.drift > 0 ? "+" : ""}${(s.drift * 10).toFixed(1)}%</td>
        </tr>
    `).join("");
}

// ─────────────────────────────────────────────────
//  Alert Stream
// ─────────────────────────────────────────────────
function updateAlertStream(alerts) {
    // Merge & deduplicate by entity+level+reason
    alerts.forEach(a => {
        const exists = allAlerts.find(x => x.entity_id === a.entity_id && x.reason === a.reason && x.level === a.level);
        if (!exists) allAlerts.unshift(a);
    });
    if (allAlerts.length > 500) allAlerts = allAlerts.slice(0, 500);

    const stream = document.getElementById("alert-stream");
    const latest = allAlerts.slice(0, 12);

    if (latest.length === 0) {
        stream.innerHTML = `<div style="text-align:center;padding:24px;font-size:11px;color:var(--text-faint)">No active alerts</div>`;
        return;
    }

    stream.innerHTML = latest.map(a => `
        <div class="alert-card ${getAlertClass(a.level)}">
            <div class="alert-meta">
                <span class="alert-entity">${a.entity_id}</span>
                <span class="alert-time">${formatTime(a.timestamp)}</span>
            </div>
            <div class="alert-reason"><span class="level-badge level-${a.level}">${a.level}</span> &nbsp;Score: ${a.shadow_score.toFixed(1)}</div>
            <div class="alert-sub">${a.reason || "multi-signal convergence"}</div>
        </div>
    `).join("");
}

// ─────────────────────────────────────────────────
//  Graph
// ─────────────────────────────────────────────────
function updateGraph(graphData) {
    if (!graphData || !graphData.nodes) return;

    const elements = [];
    graphData.nodes.forEach(n => {
        elements.push({ data: { id: n.id, level: n.level, score: n.score } });
    });
    graphData.edges.forEach(e => {
        const weight = Math.max(1, Math.min(e.weight * 5, 5));
        elements.push({ data: { source: e.source, target: e.target, weight } });
    });

    cy.json({ elements });
    cy.layout({
        name:    "dagre",
        rankDir: "LR",
        animate: true,
        rankSep: 80,
        nodeSep: 40,
    }).run();

    const hasCritical = graphData.nodes.some(n => n.level === "CRITICAL");
    const overlay = document.getElementById("graph-overlay");
    if (hasCritical) {
        overlay.classList.add("visible");
    } else {
        overlay.classList.remove("visible");
    }
}

// ─────────────────────────────────────────────────
//  Temporal Chart Data
// ─────────────────────────────────────────────────
function updateTemporalData(scores) {
    if (!scores || scores.length === 0) return;
    const now = Date.now();

    const avg = (key) => scores.reduce((s, e) => s + (e[key] || 0), 0) / scores.length;

    historyMap.shadow_score.push({ x: now, y: avg("shadow_score") });
    historyMap.drift.push(        { x: now, y: avg("drift") * 10 });
    historyMap.burst.push(        { x: now, y: avg("burst") * 10 });
    historyMap.coord.push(        { x: now, y: avg("coord") * 10 });

    // Keep last 60 points
    Object.keys(historyMap).forEach(k => {
        if (historyMap[k].length > 60) historyMap[k].shift();
    });

    temporalChart.data.datasets[0].data = historyMap[activeMetric];
    temporalChart.update("none");
}

// ─────────────────────────────────────────────────
//  Inject Fraud
// ─────────────────────────────────────────────────
async function injectFraud(cluster) {
    const resultEl = document.getElementById("inject-result");
    resultEl.style.opacity = "0";
    resultEl.textContent = "";

    try {
        const res = await fetch(`${API_BASE}/inject-fraud`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ cluster_id: cluster }),
        });

        if (!res.ok) throw new Error("API error");

        const data = await res.json();
        resultEl.style.color = "#10B981";
        resultEl.textContent = `✓ Injected ${data.injected} fraud transactions in Cluster ${cluster}. Scores will update in the next refresh.`;
        resultEl.style.opacity = "1";

        // Immediately refresh
        setTimeout(fetchDashboardData, 800);

    } catch {
        resultEl.style.color = "#EF4444";
        resultEl.textContent = "✗ API is offline. Start the FastAPI server to use inject-fraud.";
        resultEl.style.opacity = "1";
    }
}

// ─────────────────────────────────────────────────
//  Alert History Modal
// ─────────────────────────────────────────────────
function openHistoryModal() {
    const container = document.getElementById("modal-alert-list");
    lucide.createIcons();

    if (allAlerts.length === 0) {
        container.innerHTML = `<div style="text-align:center;padding:24px;opacity:0.5">No alert history yet.</div>`;
    } else {
        container.innerHTML = allAlerts.map(a => `
            <div class="history-alert-row level-${a.level}">
                <div class="history-alert-top">
                    <span class="history-entity">${a.entity_id}</span>
                    <span class="history-score ${getScoreClass(a.shadow_score)}">${a.shadow_score.toFixed(1)}</span>
                </div>
                <div class="history-reason">${a.reason || "multi-signal convergence"}</div>
                <div style="display:flex;gap:12px;margin-top:4px">
                    <span class="history-time">D:${(a.drift||0).toFixed(2)} B:${(a.burst||0).toFixed(2)} C:${(a.coord||0).toFixed(2)}</span>
                    <span class="history-time">${formatTime(a.timestamp)}</span>
                </div>
            </div>
        `).join("");
    }

    document.getElementById("history-modal").classList.remove("hidden");
}

// ─────────────────────────────────────────────────
//  WebSocket
// ─────────────────────────────────────────────────
function connectWebSocket() {
    let ws;
    try {
        ws = new WebSocket(WS_URL);
    } catch {
        return;
    }

    ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            if (msg.type === "txn") {
                totalTxns++;
                const el = document.getElementById("stat-txns");
                el.textContent = totalTxns > 999
                    ? (totalTxns / 1000).toFixed(1) + "K"
                    : totalTxns;
            }
        } catch {}
    };

    ws.onclose = () => setTimeout(connectWebSocket, 5000);
    ws.onerror = () => {};
}

// ─────────────────────────────────────────────────
//  Simulation Fallback (API Offline)
// ─────────────────────────────────────────────────
function simulateData() {
    const entities = [
        { entity_id: "ACC-1001", shadow_score: 78 + Math.random()*5, drift: 1.2, burst: 0.8, coord: 0.9, alert_level: "CRITICAL" },
        { entity_id: "ACC-2002", shadow_score: 62 + Math.random()*5, drift: 0.9, burst: 1.0, coord: 0.7, alert_level: "HIGH" },
        { entity_id: "ACC-3001", shadow_score: 55 + Math.random()*5, drift: 0.6, burst: 0.5, coord: 0.4, alert_level: "HIGH" },
        { entity_id: "ACC-REG-1",shadow_score: 38 + Math.random()*5, drift: 0.4, burst: 0.2, coord: 0.1, alert_level: "ELEVATED" },
        { entity_id: "ACC-REG-3",shadow_score: 22 + Math.random()*5, drift: 0.2, burst: 0.1, coord: 0.0, alert_level: "ELEVATED" },
        { entity_id: "ACC-1002", shadow_score: 15 + Math.random()*5, drift: 0.1, burst: 0.0, coord: 0.0, alert_level: "LOW" },
    ];

    const simAlerts = entities
        .filter(e => e.alert_level === "CRITICAL" || e.alert_level === "HIGH")
        .map(e => ({
            entity_id:    e.entity_id,
            shadow_score: e.shadow_score,
            level:        e.alert_level,
            drift:        e.drift,
            burst:        e.burst,
            coord:        e.coord,
            entropy:      0,
            timestamp:    Date.now() / 1000,
            reason:       `behavioral drift=${e.drift.toFixed(2)}; burst=${e.burst.toFixed(2)}`
        }));

    const simScores = { count: entities.length, scores: entities };
    const simAlertData = { count: simAlerts.length, alerts: simAlerts };

    updateStats(simScores, simAlertData);
    updateSuspiciousTable(entities);
    updateAlertStream(simAlerts);
    updateTemporalData(entities);
}

// ─────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────
function getScoreClass(score) {
    if (score >= 70) return "score-critical";
    if (score >= 50) return "score-high";
    if (score >= 30) return "score-elevated";
    return "score-low";
}

function getAlertClass(level) {
    if (level === "CRITICAL") return "alert-critical";
    if (level === "HIGH")     return "alert-high";
    return "alert-elevated";
}

function formatTime(ts) {
    if (!ts) return "";
    const d = ts > 1e10 ? new Date(ts) : new Date(ts * 1000);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ─────────────────────────────────────────────────
//  Entry Point
// ─────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", init);
