// ShadowScore Monitoring Dashboard Logic
// Connects to FastAPI (localhost:8000)

const API_BASE = "http://localhost:8000";
const WS_URL = "ws://localhost:8000/stream";

let cy;
let temporalChart;
let historyData = Array(30).fill(0).map((_, i) => ({ x: Date.now() - (30 - i) * 60000, y: Math.random() * 40 + 10 }));

// ─────────────────────────────────────────────
//  Initialization
// ─────────────────────────────────────────────
async function init() {
    // Lucide Icons
    lucide.createIcons();

    // Initialize Graph (Cytoscape)
    initGraph();

    // Initialize Chart (Chart.js)
    initChart();

    // Start Polling
    fetchDashboardData();
    setInterval(fetchDashboardData, 3000);

    // Initial WebSocket connection
    connectWebSocket();

    // Hide Loader
    setTimeout(() => {
        document.getElementById('loader').classList.add('opacity-0');
    }, 1200);
}

function initGraph() {
    cy = cytoscape({
        container: document.getElementById('cy'),
        style: [
            {
                selector: 'node',
                style: {
                    'background-color': '#3B82F6',
                    'label': 'data(id)',
                    'color': '#64748B',
                    'font-size': '8px',
                    'text-valign': 'bottom',
                    'text-margin-y': '5px',
                    'width': '12px',
                    'height': '12px',
                    'font-family': 'JetBrains Mono',
                }
            },
            {
                selector: 'node[level="CRITICAL"]',
                style: {
                    'background-color': '#EF4444',
                    'width': '20px',
                    'height': '20px',
                    'shadow-blur': '10px',
                    'shadow-color': '#EF4444',
                    'shadow-opacity': 0.5,
                }
            },
            {
                selector: 'node[level="HIGH"]',
                style: {
                    'background-color': '#F59E0B',
                    'width': '16px',
                    'height': '16px',
                }
            },
            {
                selector: 'edge',
                style: {
                    'width': 'data(weight)',
                    'line-color': 'rgba(59, 130, 246, 0.2)',
                    'curve-style': 'bezier',
                }
            }
        ],
        layout: { name: 'cola', infinite: true, fit: true }
    });
}

function initChart() {
    const ctx = document.getElementById('temporalChart').getContext('2d');
    temporalChart = new Chart(ctx, {
        type: 'line',
        data: {
            datasets: [{
                label: 'Shadow Score Average',
                data: historyData,
                borderColor: '#3B82F6',
                borderWidth: 2,
                pointRadius: 0,
                backgroundColor: 'rgba(59, 130, 246, 0.05)',
                fill: true,
                tension: 0.4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { display: false, type: 'linear' },
                y: { 
                    border: { display: false },
                    grid: { color: 'rgba(255,255,255,0.02)' },
                    ticks: { color: '#475569', font: { size: 9, family: 'JetBrains Mono' } },
                    min: 0, 
                    max: 100 
                }
            }
        }
    });
}

// ─────────────────────────────────────────────
//  Data Fetching
// ─────────────────────────────────────────────
async function fetchDashboardData() {
    try {
        const [scoresRes, alertsRes, graphRes] = await Promise.all([
            fetch(`${API_BASE}/scores`),
            fetch(`${API_BASE}/alerts`),
            fetch(`${API_BASE}/graph`)
        ]);

        const scores = await scoresRes.json();
        const alerts = await alertsRes.json();
        const graph = await graphRes.json();

        updateStats(scores, alerts);
        updateSuspiciousTable(scores.scores || []);
        updateAlertStream(alerts.alerts || []);
        updateGraph(graph);
        updateTemporalData(scores.scores || []);

    } catch (err) {
        console.warn("API Connection failed. Using dummy data for visualization.", err);
        simulateData();
    }
}

function updateStats(scoresData, alertsData) {
    document.getElementById('stat-txns').innerText = (12.4 + Math.random() * 2).toFixed(1) + "K";
    document.getElementById('stat-users').innerText = scoresData.count || 0;
    document.getElementById('stat-alerts').innerText = alertsData.count || 0;
}

function updateSuspiciousTable(scores) {
    const tbody = document.getElementById('suspicious-table-body');
    const suspicious = scores.filter(s => s.shadow_score > 30).slice(0, 15);
    
    // Sort by score desc
    suspicious.sort((a,b) => b.shadow_score - a.shadow_score);

    tbody.innerHTML = suspicious.map(s => `
        <tr class="border-b border-slate-800/30 transition-colors">
            <td class="p-3 text-slate-400">${s.entity_id}</td>
            <td class="p-3 text-right ${getScoreColor(s.shadow_score)} font-bold">${s.shadow_score.toFixed(1)}</td>
            <td class="p-3 text-right text-slate-500">${s.drift > 0 ? '+' : ''}${ (s.drift * 10).toFixed(1)}%</td>
        </tr>
    `).join('');
}

function updateAlertStream(alerts) {
    const stream = document.getElementById('alert-stream');
    const latest = alerts.slice(0, 10);
    
    stream.innerHTML = latest.map(a => `
        <div class="alert-card p-3 rounded bg-white/5 flex flex-col gap-1 ${getAlertClass(a.level)}">
            <div class="flex justify-between items-center">
                <span class="text-[9px] font-bold uppercase tracking-wider">${a.entity_id}</span>
                <span class="text-[8px] opacity-40">${new Date().toLocaleTimeString()}</span>
            </div>
            <div class="text-[10px] font-bold text-slate-100">${a.reason.split(';')[0]}</div>
            <div class="text-[8px] opacity-60 line-clamp-1">${a.reason}</div>
        </div>
    `).join('');
}

function updateGraph(graphData) {
    if (!graphData.nodes) return;
    
    const elements = [];
    graphData.nodes.forEach(n => {
        elements.push({ data: { id: n.id, level: n.level, score: n.score } });
    });
    graphData.edges.forEach(e => {
        elements.push({ data: { source: e.source, target: e.target, weight: e.weight * 5 } });
    });

    cy.json({ elements });
    cy.layout({ name: 'cola', animate: true, refresh: 1, maxSimulationTime: 1000 }).run();

    const hasCritical = graphData.nodes.some(n => n.level === 'CRITICAL');
    document.getElementById('graph-overlay').style.opacity = hasCritical ? 1 : 0;
}

function updateTemporalData(scores) {
    if (scores.length === 0) return;
    const avg = scores.reduce((a,b) => a + b.shadow_score, 0) / scores.length;
    
    historyData.push({ x: Date.now(), y: avg });
    if (historyData.length > 50) historyData.shift();

    temporalChart.data.datasets[0].data = historyData;
    temporalChart.update('none');
}

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────
function getScoreColor(score) {
    if (score >= 70) return 'text-red-500';
    if (score >= 50) return 'text-orange-500';
    if (score >= 30) return 'text-amber-400';
    return 'text-emerald-500';
}

function getAlertClass(level) {
    if (level === 'CRITICAL') return 'alert-critical';
    if (level === 'HIGH') return 'alert-warning';
    return 'alert-elevated';
}

function connectWebSocket() {
    const ws = new WebSocket(WS_URL);
    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'txn') {
            // Briefly pulse the header
            document.getElementById('stat-txns').classList.add('text-white');
            setTimeout(() => document.getElementById('stat-txns').classList.remove('text-white'), 100);
        }
    };
    ws.onclose = () => setTimeout(connectWebSocket, 5000);
}

// ─────────────────────────────────────────────
//  Simulation (Fallback)
// ─────────────────────────────────────────────
function simulateData() {
    const entities = ["USR_9021_X", "USR_4482_A", "USR_1189_Z", "USR_8820_K", "USR_2521_N", "USR_7734_P"];
    const dummyScores = entities.map(id => ({
        entity_id: id,
        shadow_score: Math.random() * 99,
        drift: Math.random() * 2,
        alert_level: Math.random() > 0.8 ? 'CRITICAL' : 'LOW'
    }));
    updateSuspiciousTable(dummyScores);
    
    if (Math.random() > 0.7) {
        const randomID = entities[Math.floor(Math.random() * entities.length)];
        const dummyAlerts = [{ entity_id: randomID, level: 'HIGH', reason: 'COORD_VOL_SPIKE', shadow_score: 85 }];
        updateAlertStream(dummyAlerts);
    }
}

// ─────────────────────────────────────────────
//  Entry Point
// ─────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', init);
