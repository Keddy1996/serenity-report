/**
 * ============================================
 * Serenity 投研报告生成器 - 前端 v3 (Premium)
 *
 * 架构：
 *   用户输入股票 → POST /api/analyze { stock: "xxx" }
 *     → 后端：NeoData 取数据 + DeepSeek AI 执行四维分析
 *     → 返回完整结构化 JSON
 *   → 前端：Chart.js 渲染图表 + html2pdf.js 导出 A4 PDF
 *
 * v3 变更：
 *   - 修复 checkHealth() 闭合括号缺失导致函数嵌套的严重 bug
 *   - 增加防重复提交机制
 *   - 改进 PEG 图表为仪表盘式展示
 *   - 增强错误处理和重试逻辑
 *   - 增加进度条动画
 *   - 优化 PDF 导出样式
 * ============================================
 */

'use strict';

// ==================== 全局状态 ====================
const AppState = {
  stockName: '',
  stockCode: '',
  rawData: null,
  analysis: { peg: null, gfDma: null, bayesian: null, alpha: null, conclusion: null },
  charts: {},
  isAnalyzing: false,
};

// DOM 快捷引用
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const API_BASE = '/api';
const ANALYZE_TIMEOUT = 120_000; // 2分钟超时


// ==================== 初始化 & 事件绑定 ====================
document.addEventListener('DOMContentLoaded', () => {
  // 检查 CDN 依赖是否加载成功
  if (typeof Chart === 'undefined') {
    console.error('[FATAL] Chart.js 未加载 — 请检查网络连接或 CDN 可用性');
    document.body.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;background:#0a0e1a;color:#e2e8f0;font-family:system-ui;text-align:center;padding:40px">
        <div>
          <div style="font-size:48px;margin-bottom:16px">🌐</div>
          <h2 style="margin:0 0 8px;color:#ef4444">网络资源加载失败</h2>
          <p style="color:#94a3b8;margin:0 0 20px;max-width:400px">
            Chart.js 库未能从 CDN 加载。<br/>请检查网络连接后刷新页面。
          </p>
          <button onclick="location.reload()" style="padding:10px 24px;background:#3b82f6;border:none;color:#fff;border-radius:8px;cursor:pointer;font-size:14px">
            🔄 刷新页面
          </button>
        </div>
      </div>`;
    return;
  }
  console.log('[Init] Chart.js v' + Chart.version + ' ✓ | html2pdf:', typeof html2pdf !== 'undefined' ? '✓' : '✗ (PDF导出不可用)');

  bindEvents();
  checkHealth();
});

function bindEvents() {
  const analyzeBtn = $('#btnAnalyze');
  const inputEl = $('#stockInput');

  if (analyzeBtn) analyzeBtn.addEventListener('click', onAnalyze);
  if (inputEl) inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') onAnalyze(); });

  // 快捷选择标签
  $$('.tag').forEach((t) => t.addEventListener('click', () => { $('#stockInput').value = t.dataset.stock; onAnalyze(); }));

  // 重试按钮
  const retryBtn = document.querySelector('.btn-retry');
  if (retryBtn) retryBtn.addEventListener('click', () => hideAll());

  // 导出按钮
  const exportBtn = $('#btnExport');
  if (exportBtn) exportBtn.addEventListener('click', exportPDF);
}

/**
 * 启动时检查后端健康状态 & DeepSeek 配置
 */
async function checkHealth() {
  try {
    const resp = await fetch(`${API_BASE}/health`);
    if (!resp.ok) return;
    const info = await resp.json();
    console.log('[Health]', JSON.stringify(info));

    const dot = $('#healthIndicator');
    if (!dot) return;

    if (info.deepseek && info.deepseek !== 'MISSING') {
      dot.classList.add('online');
      dot.title = `DeepSeek ${info.model || 'OK'} · 后端在线`;
    } else {
      dot.classList.add('offline');
      dot.title = 'DeepSeek 未配置 · 分析可能不可用';
      console.warn('[WARN] DeepSeek API Key 未配置，分析功能可能不可用');
    }
  } catch (_) {
    console.error('[ERROR] 无法连接到后端服务');
    const dot = $('#healthIndicator');
    if (dot) { dot.classList.add('offline'); dot.title = '后端离线'; }
  }
}


// ==================== 核心流程：一键分析（防重复提交）====================
async function onAnalyze() {
  if (AppState.isAnalyzing) return; // 防止重复点击

  const input = $('#stockInput');
  const query = input?.value.trim();
  if (!query) { shakeInput(); return; }

  // 锁定状态
  AppState.isAnalyzing = true;

  // UI 状态切换
  showLoading();
  updateProgress(0);
  setStep(1);
  setLoadingText(`正在分析「${query}」...`);

  const analyzeBtn = $('#btnAnalyze');
  if (analyzeBtn) { analyzeBtn.disabled = true; analyzeBtn.innerHTML = '<span class="btn-icon">⏳</span> 分析中...'; }

  try {
    // 调用后端 API
    setStep(1); setLoadingText('正在采集数据...');
    const apiResult = await callAnalyzeAPI(query);

    // 验证返回数据
    if (!apiResult.success) throw new Error(apiResult.error || '后端返回错误');
    if (!apiResult.basic) throw new Error('后端未返回股票基本信息');

    // 存储全局状态
    AppState.rawData = apiResult;
    AppState.stockName = apiResult.basic.name || query;
    AppState.stockCode = apiResult.basic.code || '';
    AppState.analysis.peg = apiResult.peg;
    AppState.analysis.gfDma = apiResult.gfDma;
    AppState.analysis.bayesian = apiResult.bayesian;
    AppState.analysis.alpha = apiResult.alpha;
    AppState.analysis.conclusion = apiResult.conclusion;

    doneStep(1); updateProgress(16);

    // 分步渲染动画（用户体验优化）
    await animateSteps();

    // 渲染全部图表和内容
    renderReport();

    // 完成
    hideLoading();
    showReport();
    $('#btnExport').disabled = false;

  } catch (err) {
    showError(err.message);
    console.error('[Analyze Error]', err);
  } finally {
    AppState.isAnalyzing = false;
    if (analyzeBtn) { analyzeBtn.disabled = false; analyzeBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> 开始分析'; }
  }
}

/** 分步进度动画 */
async function animateSteps() {
  const steps = [
    { n: 2, text: '计算 TAM-Adj-PEG...', pct: 33 },
    { n: 3, text: '评估 GF-DMA 健康度...', pct: 50 },
    { n: 4, text: '运行贝叶斯估值模型...', pct: 66 },
    { n: 5, text: '扫描 Alpha 信号...', pct: 83 },
    { n: 6, text: '渲染报告...', pct: 95 },
  ];
  for (const s of steps) {
    setStep(s.n); setLoadingText(s.text); updateProgress(s.pct);
    await delay(280);
    doneStep(s.n);
  }
  setLoadingText('完成！'); updateProgress(100);
}


// ==================== API 调用 ====================
async function callAnalyzeAPI(stockQuery) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ANALYZE_TIMEOUT);

  try {
    const resp = await fetch(`${API_BASE}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stock: stockQuery }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!resp.ok) {
      let errMsg = `服务器错误 (${resp.status})`;
      try { const b = await resp.json(); errMsg = b.error || errMsg; } catch (_) {}
      throw new Error(errMsg);
    }

    return resp.json();
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('分析超时（>2分钟），请稍后重试');
    // 友好化网络错误消息
    const msg = String(err.message || '');
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('TypeError'))
      throw new Error('无法连接到分析服务器 — 请确认后端服务正在运行 (localhost:3210)');
    if (msg.includes('JSON')) throw new Error('数据解析异常，请重试');
    throw err;
  }
}


// ==================== 报告渲染 ====================
function renderReport() {
  const d = AppState.rawData;
  const a = AppState.analysis;
  if (!d) return;

  // ---- 头部信息 ----
  setText('rptStockName', d.basic?.name || AppState.stockName);
  setText('rptStockCode', d.basic?.code || AppState.stockCode);
  setText('rptDate', formatDate(new Date()));

  // 数据来源标签
  const dsLabel = document.getElementById('rptDataSource');
  if (dsLabel) dsLabel.textContent = d.dataSource === 'neodata' ? 'NeoData 实时数据' : 'DeepSeek 知识库';

  // 涨跌幅徽章
  const priceBadge = document.getElementById('rptPriceChange');
  if (priceBadge && d.basic?.changePct != null) {
    const chg = parseFloat(d.basic.changePct);
    priceBadge.textContent = `${chg >= 0 ? '+' : ''}${chg}%`;
    priceBadge.className = `stock-price-change ${chg >= 0 ? 'price-up' : 'price-down'}`;
  }

  // ---- 综合判定徽章 ----
  const verdictText = a.conclusion?.verdict || '中性';
  const badge = document.getElementById('rptVerdict');
  if (badge) {
    badge.querySelector('.verdict-text').textContent = verdictText;
    badge.className = `verdict-badge ${verdictToClass(verdictText)}`;
  }

  // ---- 各模块渲染 ----
  renderMetrics(d);
  renderPEGChart(a.peg);
  renderGFChart(a.gfDma);
  renderBayesChart(a.bayesian);
  renderAlphaPanel(a.alpha);
  renderConclusion(a, d, verdictText);

  // 页脚数据来源
  const footerDS = document.getElementById('footerDataSource');
  if (footerDS) footerDS.textContent = d.dataSource === 'neodata' ? 'NeoData / 东方财富' : 'DeepSeek 知识库';
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function verdictToClass(v) {
  if (v.includes('买')) return 'verdict-buy';
  if (v.includes('观')) return 'verdict-watch';
  if (v.includes('慎') || v.includes('卖')) return 'verdict-sell';
  return 'verdict-hold';
}


// ---- 核心指标卡片 ----
function renderMetrics(d) {
  if (!d || !d.basic) return;
  const b = d.basic, v = d.valuation || {}, f = d.financials || {};
  const chg = parseFloat(b.changePct || 0);

  const items = [
    { label: '最新价', value: formatNumber(b.price, 2), sub: `${chg >= 0 ? '+' : ''}${chg}%`, cls: chg >= 0 ? 'val-up' : 'val-down' },
    { label: 'PE(TTM)', value: v.peTTM ?? '--', sub: `Fwd PE: ${v.forwardPE ?? '--'}`, cls: parseFloat(v.peTTM) > 50 ? 'val-down' : 'val-neutral' },
    { label: '市值', value: `${b.marketCap ?? '--'}亿`, sub: b.currency === 'USD' ? 'USD' : 'CNY', cls: 'val-neutral' },
    { label: '营收增速', value: `${f.revenueGrowth ?? '--'}%`, sub: `净利: ${f.profitGrowth ? '+' + f.profitGrowth + '%' : '--'}`, cls: parseFloat(f.revenueGrowth) > 20 ? 'val-up' : 'val-neutral' },
    { label: '毛利率', value: `${f.grossMargin ?? '--'}%`, sub: `净利率: ${f.netMargin ?? '--'}%`, cls: parseFloat(f.grossMargin) > 45 ? 'val-up' : 'val-neutral' },
    { label: 'ROE', value: `${f.roe ?? '--'}%`, sub: `研发占比: ${f.rdRatio ?? '--'}%`, cls: parseFloat(f.roe) > 15 ? 'val-up' : 'val-neutral' },
  ];

  const grid = document.getElementById('metricsGrid');
  if (!grid) return;
  grid.innerHTML = items.map(m =>
    `<div class="metric-item">
      <div class="metric-label">${m.label}</div>
      <div class="metric-value ${m.cls}">${m.value}</div>
      <div class="metric-sub">${m.sub}</div>
    </div>`
  ).join('');
}


// ==================== 图表渲染 ====================
const CHART_COLORS = {
  green: '#10b981', red: '#ef4444', orange: '#f59e0b', blue: '#3b82f6', cyan: '#06b6d4',
  purple: '#8b5cf6', muted: '#64748b', border: 'rgba(56,74,102,.5)', grid: 'rgba(56,74,102,.35)',
  bgCard: 'rgba(20,30,48,.75)',
};

// --- TAM-Adj-PEG 仪表盘图 ---
function renderPEGChart(peg) {
  if (!peg) return;
  destroyChart('pegGauge');

  const ctx = getCanvasCtx('pegGauge');
  if (!ctx) return;

  const val = Math.min(Math.max(parseFloat(peg.pegValue) || 2, 0), 4);
  const zones = [
    { max: 0.8, color: CHART_COLORS.green, label: '深度低估(<0.8)' },
    { max: 1.2, color: CHART_COLORS.green, label: '低估(0.8-1.2)' },
    { max: 1.8, color: CHART_COLORS.orange, label: '合理偏低(1.2-1.8)' },
    { max: 2.5, color: CHART_COLORS.red, label: '偏贵(1.8-2.5)' },
    { max: 4.0, color: CHART_COLORS.red, label: '高估泡沫(>2.5)' },
  ];

  const chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: zones.map(z => z.label),
      datasets: [{
        label: '估值区间',
        data: [0.8, 1.2, 1.8, 2.5, 3.5],
        backgroundColor: zones.map(z => z.color + '40'), // 透明背景
        borderColor: zones.map(z => z.color),
        borderWidth: 2,
        borderRadius: 8,
        barThickness: 22,
        borderSkipped: false,
      }, {
        label: peg.name || '当前值',
        // 智能定位当前值到对应区间
        data: placeValueInZones(val, 5),
        backgroundColor: peg.color || CHART_COLORS.orange,
        borderColor: '#fff',
        borderWidth: 2,
        barThickness: 28,
        borderRadius: 8,
        borderSkipped: false,
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => ctx.datasetIndex === 1 ? `当前 PEG: ${val.toFixed(2)}` : ''
          }
        },
      },
      scales: {
        x: {
          title: { display: true, text: 'TAM-Adj-PEG →', color: CHART_COLORS.muted, font: { size: 11, weight: '600' } },
          grid: { color: CHART_COLORS.grid },
          ticks: { color: CHART_COLORS.muted, font: { size: 10 }, callback: v => v.toFixed(1) },
          min: 0, max: 4,
        },
        y: {
          grid: { display: false },
          ticks: { color: c => zones[c.index]?.color || CHART_COLORS.muted, font: { size: 11, weight: '500' } },
        }
      }
    }
  });
  AppState.charts.peg = chart;

  // 详情面板
  const detail = document.getElementById('pegDetail');
  if (detail) detail.innerHTML = `
    <div class="peg-row"><span>Forward PE</span><strong>${peg.forwardPE || '--'}</strong></div>
    <div class="peg-row"><span>原始 EPS 增速</span><strong>${peg.epsGrowth || '--'}</strong></div>
    <div class="peg-row"><span>TAM Runway Factor</span><strong>${peg.trf || '--'}</strong></div>
    <div class="peg-row"><span>Quality Factor</span><strong>${peg.qf || '--'}</strong></div>
    <div class="peg-row"><span style="font-weight:600;">修正增速</span><strong>${peg.adjustedGR || '--'}</strong></div>
    <hr style="border-color:#30363d;margin:10px 0"/>
    <div class="peg-row" style="font-size:15px;">
      <span style="font-weight:700;">TAM-Adj-PEG</span>
      <strong style="color:${peg.color||CHART_COLORS.orange};font-size:18px;">${peg.pegValue || '--'}</strong>
    </div>
    <div class="peg-row"><span>评级</span><strong style="color:${peg.color||CHART_COLORS.orange};font-weight:700;">${peg.grade || '--'}</strong></div>
    <div class="peg-row"><span>操作建议</span><strong>${peg.advice || '--'}</strong></div>`;
}

/** 将 PEG 值智能放入对应区间位置 */
function placeValueInZones(val, zoneCount) {
  const arr = new Array(zoneCount).fill(null);
  let targetIdx;
  if (val <= 0.8) targetIdx = 0;
  else if (val <= 1.2) targetIdx = 1;
  else if (val <= 1.8) targetIdx = 2;
  else if (val <= 2.5) targetIdx = 3;
  else targetIdx = 4;
  arr[targetIdx] = val;
  return arr;
}


// --- GF-DMA 雷达图 ---
function renderGFChart(gf) {
  if (!gf) return;
  destroyChart('gfRadarChart');
  const ctx = getCanvasCtx('gfRadarChart');
  if (!ctx) return;

  const dims = gf.dims || [];
  const chart = new Chart(ctx, {
    type: 'radar',
    data: {
      labels: dims.map(d => d.label),
      datasets: [{
        data: dims.map(d => d.value),
        backgroundColor: 'rgba(6,182,212,.15)',
        borderColor: CHART_COLORS.cyan,
        pointBackgroundColor: CHART_COLORS.cyan,
        pointBorderColor: '#fff',
        pointRadius: 5,
        pointHoverRadius: 7,
        pointBorderWidth: 2,
        borderWidth: 2.5,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        r: {
          beginAtZero: true,
          max: dims.reduce((a, d) => Math.max(a, d.max || 40), 0) || 40,
          grid: { color: CHART_COLORS.grid },
          angleLines: { color: 'rgba(56,74,102,.3)' },
          pointLabels: { color: CHART_COLORS.muted, font: { size: 11, weight: '500' } },
          ticks: { stepSize: 10, color: CHART_COLORS.muted, backdropColor: 'transparent', font: { size: 9 } },
        }
      },
      animation: { duration: 800, easing: 'easeOutQuart' },
    }
  });
  AppState.charts.gfDma = chart;

  setText('gfScore', gf.total ?? '--');
  const scoreEl = document.getElementById('gfScore');
  if (scoreEl) scoreEl.style.cssText = `color:${gf.zoneColor || CHART_COLORS.orange}`;

  const gv = document.getElementById('gfVerdict');
  if (gv) {
    gv.textContent = `${gf.zone || '--'}: ${gf.verdict || ''}`;
    gv.style.cssText = `background:${(gf.zoneColor || CHART_COLORS.orange)}18;color:${gf.zoneColor || CHART_COLORS.orange};border:1px solid ${(gf.zoneColor || CHART_COLORS.orange)}40;border-radius:20px;padding:8px 24px;font-weight:700;font-size:13px;`;
  }
}


// --- 贝叶斯概率分布图 ---
function renderBayesChart(bayes) {
  if (!bayes) return;
  destroyChart('bayesBarChart');
  const ctx = getCanvasCtx('bayesBarChart');
  if (!ctx) return;

  const hypos = bayes.hypotheses || [];
  const colors = hypos.map(h => {
    const p = h.posterior || 0;
    if (p > 0.30) return 'rgba(16,185,129,.72)';
    if (p > 0.15) return 'rgba(59,130,246,.72)';
    if (p > 0.07) return 'rgba(245,158,11,.72)';
    return 'rgba(100,116,139,.50)';
  });

  const chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: hypos.map(h => h.label),
      datasets: [{
        label: '后验概率',
        data: hypos.map(h => ((h.posterior || 0) * 100).toFixed(1)),
        backgroundColor: colors,
        borderRadius: 6,
        barThickness: 26,
        hoverBackgroundColor: colors.map(c => c.replace('.72', '.92')),
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: (item) => `${item.raw}% · 增速 ${hypos[item.dataIndex]?.rate ?? '--'}%` },
          backgroundColor: 'rgba(15,23,42,.9)',
          borderColor: 'rgba(56,74,102,.5)',
          borderWidth: 1,
          cornerRadius: 8,
          padding: 10,
          titleFont: { weight: '600' },
        },
      },
      scales: {
        x: {
          title: { display: true, text: '后验概率 (%)', color: CHART_COLORS.muted, font: { size: 11, weight: '600' } },
          grid: { color: CHART_COLORS.grid },
          ticks: { color: CHART_COLORS.muted, callback: v => v + '%' },
          max: 60,
        },
        y: { grid: { display: false }, ticks: { color: '#e2e8f0', font: { size: 12, weight: '500' } } }
      },
      animation: { duration: 900, easing: 'easeOutQuart' },
    }
  });
  AppState.charts.bayes = chart;

  // 对比表
  const diff = parseFloat(bayes.diff) || 0;
  const diffColor = diff > 0 ? CHART_COLORS.green : (diff > -3 ? CHART_COLORS.orange : CHART_COLORS.red);
  const bc = document.getElementById('bayesCompare');
  if (bc) bc.innerHTML = `
    <table style="width:100%;font-size:13px;border-collapse:collapse;">
      <tr><td style="padding:5px 0;color:${CHART_COLORS.muted};">模型加权内在增速</td><td style="text-align:right;font-weight:700;font-size:15px;font-family:var(--font-mono);">${bayes.intrinsicGrowth || '--'}%</td></tr>
      <tr><td style="padding:4px 0;color:${CHART_COLORS.muted};">市场隐含增速</td><td style="text-align:right;font-weight:700;font-size:15px;font-family:var(--font-mono);">${bayes.impliedGrowth || '--'}%</td></tr>
      <tr style="border-top:1px solid #30363d;">
        <td style="padding:8px 0 4px;color:${CHART_COLORS.muted};">差值 (内在 - 隐含)</td>
        <td style="padding:8px 0 4px;text-align:right;font-weight:800;font-size:17px;font-family:var(--font-mono);color:${diffColor};">${diff > 0 ? '+' : ''}${diff}%</td></tr>
      <tr><td style="padding:4px 0;color:${CHART_COLORS.muted};">主导假设</td><td style="text-align:right;font-weight:600;">${bayes.dominantHypothesis || '--'}</td></tr>
      <tr><td colspan="2" style="padding:10px 0 0;font-weight:600;color:${diffColor};font-size:13px;">→ ${bayes.conclusion || '--'}</td></tr>
    </table>`;
}


// --- Alpha 评分面板 ---
function renderAlphaPanel(alpha) {
  if (!alpha) return;

  // 星星评分
  const starsEl = document.getElementById('alphaStars');
  const starCount = Math.min(5, Math.max(0, Math.round(alpha.stars || 0)));
  if (starsEl) {
    starsEl.innerHTML = Array.from({ length: 5 }, (_, i) =>
      `<span class="${i < starCount ? 'star-on' : 'star-off'}">&#9733;</span>`
    ).join('');
  }
  setText('alphaScore', `${alpha.score || '--'}/5`);

  // 事件列表
  const eventsContainer = document.getElementById('alphaEvents');
  if (!eventsContainer) return;
  const events = alpha.events || [];

  eventsContainer.innerHTML = events.length > 0
    ? events.map(e => `
      <div class="event-item ${e.type}">
        <span class="event-tag" style="color:${
          e.type === 'positive' ? CHART_COLORS.green :
          e.type === 'negative' ? CHART_COLORS.red : CHART_COLORS.orange
        };font-size:11px;">[${e.tag || ''}]</span>
        <span class="event-desc">${e.desc || ''}</span>
      </div>`).join('')
    : '<p style="color:#64748b;text-align:center;padding:24px 12px;font-style:italic;">暂无近期重要催化事件</p>';
}


// --- 综合结论面板 ---
function renderConclusion(a, d, verdictText) {
  const cb = document.getElementById('conclusionBody');
  if (!cb) return;
  const conc = a.conclusion || {};
  const posList = conc.bullCase || [];
  const negList = conc.bearCase || [];

  cb.innerHTML = `
    ${conc.summary ? `<p style="margin-bottom:14px;line-height:1.95;"><strong style="color:#f1f5f9;">核心观点：</strong>${conc.summary}</p>` : ''}

    <p style="margin-bottom:8px;font-weight:700;color:#94a3b8;">📊 四维评分总览：</p>
    <ul style="margin:6px 0;padding-left:20px;line-height:2.05;">
      <li>TAM-Adj-PEG：<span style="color:${a.peg?.color||CHART_COLORS.orange};font-weight:700;font-family:var(--font-mono);">${a.peg?.pegValue || '--'}</span> <span style="color:#64748b;font-size:12px;">(${a.peg?.grade || '--'})</span></li>
      <li>GF-DMA：<span style="color:${a.gfDma?.zoneColor||CHART_COLORS.orange};font-weight:700;font-family:var(--font-mono);">${a.gfDma?.total || '--'}/100</span> <span style="color:#64748b;font-size:12px;">(${a.gfDma?.zone || '--'})</span></li>
      <li>贝叶斯：内在 <span style="font-weight:700;font-family:var(--font-mono);">${a.bayesian?.intrinsicGrowth || '--'}%</span> vs 隐含 <span style="font-weight:700;font-family:var(--font-mono);">${a.bayesian?.impliedGrowth || '--'}%</span></li>
      <li>Alpha：<span style="color:#f59e0b;font-weight:700;font-family:var(--font-mono);">${a.alpha?.score || '--'}/5</span> <span style="color:#64748b;font-size:12px;">(${alphaLevelText(a.alpha?.score)})</span></li>
    </ul>

    ${posList.length ? `<p style="margin-top:14px;margin-bottom:6px;font-weight:700;color:#10b981;">✓ 利好因素：</p>
    <div style="display:flex;flex-direction:column;gap:6px;margin:4px 0 8px;">
      ${posList.map(f => `<span class="highlight highlight-green">✓ ${f}</span>`).join('')}
    </div>` : ''}

    ${negList.length ? `<p style="margin-top:10px;margin-bottom:6px;font-weight:700;color:#ef4444;">✗ 风险因素：</p>
    <div style="display:flex;flex-direction:column;gap:6px;margin:4px 0 8px;">
      ${negList.map(f => `<span class="highlight highlight-red">✗ ${f}</span>`).join('')}
    </div>` : ''}

    <div style="margin-top:18px;padding:16px 20px;border-radius:12px;background:linear-gradient(135deg, rgba(59,130,246,.08), rgba(59,130,246,.03));border:1px solid rgba(59,130,246,.15);">
      <div style="font-size:16px;font-weight:800;color:#f1f5f9;">综合建议：${verdictText}</div>
      ${conc.positionAdvice ? `<div style="margin-top:8px;line-height:1.85;color:#94a3b8;">${conc.positionAdvice}</div>` : ''}
    </div>`;
}

function alphaLevelText(score) {
  const s = parseFloat(score) || 0;
  if (s >= 4) return '强 Alpha';
  if (s >= 3) return '中等 Alpha';
  if (s >= 2) return '弱 Alpha';
  return '无 Alpha';
}


// ==================== 工具函数 ====================
function getCanvasCtx(id) {
  const el = document.getElementById(id);
  return el ? el.getContext('2d') : null;
}

function destroyChart(id) {
  if (AppState.charts[id]) {
    AppState.charts[id].destroy();
    delete AppState.charts[id];
  }
}

function formatNumber(num, decimals = 2) {
  if (num == null || num === '--') return '--';
  return Number(num).toLocaleString('zh-CN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function formatDate(date) {
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }


// ==================== UI 状态控制 ====================
function showLoading()   { hideAll(); const el = document.getElementById('loadingSection'); if (el) el.classList.remove('hidden'); }
function hideLoading()   { const el = document.getElementById('loadingSection'); if (el) el.classList.add('hidden'); }
function showReport()    { const el = document.getElementById('reportSection'); if (el) el.classList.remove('hidden'); }
function hideReport()    { const el = document.getElementById('reportSection'); if (el) el.classList.add('hidden'); }
function showError(msg)  {
  hideAll();
  const el = document.getElementById('errorMsg');
  const sec = document.getElementById('errorSection');
  if (el) el.textContent = msg;
  if (sec) sec.classList.remove('hidden');
}
function hideAll()       { hideLoading(); hideReport(); const el = document.getElementById('errorSection'); if (el) el.classList.add('hidden'); }

function setLoadingText(text) { const el = document.getElementById('loadingText'); if (el) el.textContent = text; }

function updateProgress(pct) { const el = document.getElementById('progressFill'); if (el) el.style.width = `${pct}%`; }

function setStep(n) {
  $$('.step').forEach(s => s.classList.remove('active'));
  const el = document.querySelector(`.step[data-step="${n}"]`);
  if (el) el.classList.add('active');
}
function doneStep(n) {
  const el = document.querySelector(`.step[data-step="${n}"]`);
  if (el) { el.classList.remove('active'); el.classList.add('done'); }
}

function shakeInput() {
  const el = document.getElementById('stockInput');
  if (!el) return;
  el.classList.add('shake');
  setTimeout(() => el.classList.remove('shake'), 400);
}


// ==================== A4 PDF 导出 ====================
async function exportPDF() {
  const btn = $('#btnExport');
  if (!btn) return;
  const origHTML = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="btn-icon">⏳</span> 正在生成...';

  const element = document.getElementById('reportContent');
  const name = AppState.stockName || 'report';

  // 先隐藏一些不需要导出的元素
  const hiddenEls = [];
  $$('.glass-card .card-header .card-icon').forEach(el => { el.style.display = 'none'; hiddenEls.push(el); });

  const opt = {
    margin: [8, 10],
    filename: `Serenity投研报告_${name}_${formatDate(new Date())}.pdf`,
    image: { type: 'jpeg', quality: 0.96 },
    html2canvas: {
      scale: 2, useCORS: true, logging: false,
      backgroundColor: '#111827', letterRendering: true,
      allowTaint: false,
    },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
    pagebreak: { mode: ['avoid-all', 'css', 'legacy'] },
  };

  try {
    await html2pdf().set(opt).from(element).save();
  } catch (err) {
    console.error('[PDF Export]', err);
    alert('PDF 导出失败: ' + err.message);
  } finally {
    // 恢复隐藏元素
    hiddenEls.forEach(el => { el.style.display = ''; });
    btn.disabled = false;
    btn.innerHTML = origHTML;
  }
}
