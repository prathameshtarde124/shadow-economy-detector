/**
 * ShadowScore Tactical Dashboard Logic
 * Elite UX: Fraud Auto-Focus Zoom, Zero-Fluff Data.
 */

const API_BASE = "http://localhost:8001";
const WS_URL   = "ws://localhost:8001/stream";

// ─── State ───────────────────────────────────────
let cy;
let temporalChart;
let activeMetric = "shadow_score";
let historyMap   = { shadow_score: [], drift: [], burst: [], coord: [] };
let allAlerts    = [];
let isSimRunning = true;

// ─────────────────────────────────────────────────
//  Initialization
// ─────────────────────────────────────────────────
function init() {
    lucide.createIcons();
    initGraph();
    initChart();
    bindControls();
    
    fetchDashboardData();
    setInterval(fetchDashboardData, 3000);
    connectWebSocket();
}

// ─────────────────────────────────────────────────
//  Controls
// ─────────────────────────────────────────────────
function bindControls() {
    document.getElementById("pause-btn").addEventListener("click", async () => {
        try {
            const res = await fetch(`${API_BASE}/toggle-simulation`, { method: "POST" });
            const data = await res.json();
            isSimRunning = data.running;
            document.getElementById("pause-btn").textContent = isSimRunning ? "| |" : ">";
        } catch (e) { console.error(e); }
    });

    document.getElementById("inject-fraud-btn").addEventListener("click", () => document.getElementById("inject-modal").classList.remove("hidden"));
    document.getElementById("close-inject-btn").addEventListener("click", () => document.getElementById("inject-modal").classList.add("hidden"));
    ["inject-a", "inject-b", "inject-c"].forEach(id => {
        document.getElementById(id).addEventListener("click", () => injectFraud(id.slice(-1).toUpperCase()));
    });

    document.getElementById("refresh-btn").addEventListener("click", fetchDashboardData);

    document.querySelectorAll(".chip").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".chip").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            activeMetric = btn.getAttribute("data-metric");
            redrawChart();
        });
    });

    document.getElementById("view-history-btn").addEventListener("click", openHistoryModal);
    document.getElementById("close-modal-btn").addEventListener("click", () => document.getElementById("history-modal").classList.add("hidden"));
}

// ─────────────────────────────────────────────────
//  Intelligence HUD
// ─────────────────────────────────────────────────
async function updateStats() {
    try {
        const res = await fetch(`${API_BASE}/stats`);
        const data = await res.json();
        document.getElementById("stat-txns").textContent = data.total_transactions;
        document.getElementById("stat-users").textContent = data.total_entities;
        document.getElementById("stat-alerts").textContent = data.total_alerts;
    } catch (e) { console.error("Stats fetch failed", e); }
}

// ─────────────────────────────────────────────────
//  Graph Module
// ─────────────────────────────────────────────────
function initGraph() {
    cy = cytoscape({
        container: document.getElementById("cy"),
        userZoomingEnabled: true,
        userPanningEnabled: true,
        boxSelectionEnabled: false,
        style: [
            { selector: "node", style: { "background-color": "#FFFFFF", "width": "12px", "height": "12px", "label": "data(id)", "color": "#666666", "font-size": "7px", "text-valign": "bottom", "text-margin-y": "4px", "font-family": "JetBrains Mono" } },
            { selector: 'node[level="CRITICAL"]', style: { "background-color": "#FF0000", "width": "20px", "height": "20px", "shadow-blur": "10px", "shadow-color": "#FF0000" } },
            { selector: 'node[level="HIGH"]', style: { "background-color": "#FFFF00", "width": "16px", "height": "16px", "color": "#000000" } },
            { selector: "edge", style: { "width": "data(weight)", "line-color": "rgba(255, 255, 255, 0.1)", "curve-style": "bezier" } },
            { selector: ".highlighted", style: { "z-index": 999, "overlay-color": "#fff", "overlay-opacity": 0.2, "border-width": 2, "border-color": "#fff" } }
        ],
        layout: { name: "grid" }
    });
}

function updateGraph(graphData) {
    if (!graphData.nodes) return;
    const elements = [];
    graphData.nodes.forEach(n => elements.push({ data: { id: n.id, level: n.level } }));
    graphData.edges.forEach(e => elements.push({ data: { source: e.source, target: e.target, weight: e.weight * 5 } }));
    
    cy.json({ elements });
    cy.layout({ name: "cose", animate: false }).run(); // Use COSE for better network clusters
}

function focusOnEntity(id, autoZoom = false) {
    const n = cy.$id(id);
    if (n.length) {
        cy.nodes().removeClass("highlighted");
        n.addClass("highlighted").neighborhood().addClass("highlighted");
        cy.animate({ center: { eles: n }, zoom: autoZoom ? 2.5 : 1.5 }, { duration: 600 });
    }
}

// ─────────────────────────────────────────────────
//  Entity Table Module
// ─────────────────────────────────────────────────
function updateSuspiciousTable(scores) {
    const tbody = document.getElementById("suspicious-table-body");
    const suspicious = scores.filter(s => s.shadow_score > 20).sort((a,b) => b.shadow_score - a.shadow_score).slice(0, 15);
    
    tbody.innerHTML = suspicious.map(s => `
        <tr onclick="focusOnEntity('${s.entity_id}', false)" style="cursor:pointer">
            <td>${s.entity_id}</td>
            <td class="${getScoreClass(s.shadow_score)}">${s.shadow_score.toFixed(1)}</td>
        </tr>
    `).join("");
}

// ─────────────────────────────────────────────────
//  Alert Stream Module
// ─────────────────────────────────────────────────
function updateAlertStream(alerts) {
    let newAlertFound = false;
    alerts.forEach(a => {
        if (!allAlerts.find(x => x.entity_id === a.entity_id && x.timestamp === a.timestamp)) {
            allAlerts.unshift(a);
            // Fraud Auto-Focus Logic:
            if (a.level === "CRITICAL" || a.level === "HIGH") {
                setTimeout(() => focusOnEntity(a.entity_id, true), 500);
            }
        }
    });

    const feed = document.getElementById("alert-stream");
    feed.innerHTML = allAlerts.slice(0, 10).map(a => `
        <div class="alert-row ${a.level.toLowerCase()}" onclick="focusOnEntity('${a.entity_id}', true)" style="cursor:pointer">
            <span style="color:var(--text-muted); font-size:7px">${new Date(a.timestamp * 1000).toLocaleTimeString()}</span>
            <span>AUTH_THREAT: ${a.entity_id}</span>
            <span style="font-size:8px; opacity:0.8">${a.reason.split(';')[0]}</span>
        </div>
    `).join("");
}

// ─────────────────────────────────────────────────
//  Data Fetching
// ─────────────────────────────────────────────────
async function fetchDashboardData() {
    try {
        const [scoresRes, alertsRes, graphRes] = await Promise.all([
            fetch(`${API_BASE}/scores`), fetch(`${API_BASE}/alerts`), fetch(`${API_BASE}/graph`)
        ]);
        const sc = await scoresRes.json();
        const al = await alertsRes.json();
        const gr = await graphRes.json();
        
        updateStats();
        updateSuspiciousTable(sc.scores);
        updateAlertStream(al.alerts);
        updateGraph(gr);
        updateTemporalData(sc.scores);
    } catch (e) { console.error("API Error", e); }
}

function initChart() {
    const ctx = document.getElementById("temporalChart").getContext("2d");
    temporalChart = new Chart(ctx, {
        type: "line", data: { datasets: [{ label: activeMetric, data: [], borderColor: "#FFFFFF", borderWidth: 1, pointRadius: 0, fill: true, backgroundColor: "rgba(255,255,255,0.03)", tension: 0.1 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { grid: { color: "#111" }, ticks: { color: "#444", font: { size: 8, family: "JetBrains Mono" } } } } }
    });
}

function updateTemporalData(scores) {
    if (!scores.length) return;
    const now = Date.now();
    const avg = (k) => scores.reduce((s, e) => s + (e[k] || 0), 0) / scores.length;
    historyMap.shadow_score.push({ x: now, y: avg("shadow_score") });
    historyMap.drift.push({ x: now, y: avg("drift") * 10 });
    historyMap.burst.push({ x: now, y: avg("burst") * 10 });
    historyMap.coord.push({ x: now, y: avg("coord") * 10 });
    Object.keys(historyMap).forEach(k => { if (historyMap[k].length > 50) historyMap[k].shift(); });
    temporalChart.data.datasets[0].data = historyMap[activeMetric];
    temporalChart.update("none");
}

function redrawChart() {
    const color = activeMetric === "shadow_score" ? "#FFFFFF" : activeMetric === "drift" ? "#FFFF00" : activeMetric === "burst" ? "#FF0000" : "#00FF00";
    temporalChart.data.datasets[0].borderColor = color;
    temporalChart.update();
}

function getScoreClass(s) { return s > 70 ? "score-red" : s > 40 ? "score-yellow" : "score-green"; }
function getLevelColor(l) { return l === "CRITICAL" ? "#FF0000" : l === "HIGH" ? "#FFFF00" : "#00FF00"; }
function connectWebSocket() {
    const ws = new WebSocket(WS_URL);
    ws.onmessage = () => updateStats();
    ws.onclose = () => setTimeout(connectWebSocket, 5000);
}
async function injectFraud(c) {
    await fetch(`${API_BASE}/inject-fraud`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cluster_id: c }) });
    document.getElementById("inject-modal").classList.add("hidden");
    fetchDashboardData();
}
function openHistoryModal() {
    const container = document.getElementById("modal-alert-list");
    container.innerHTML = allAlerts.map(a => `<div style="padding:5px; font-family:var(--font-mono); font-size:10px; border-bottom:1px solid #222;">${a.entity_id} - ${a.level} - ${a.reason}</div>`).join("");
    document.getElementById("history-modal").classList.remove("hidden");
}
window.addEventListener("DOMContentLoaded", init);
