/**
 * ============================================
 * Serenity 投研报告 - 后端服务 v3.1 (Hotfix)
 *
 * v3.1 修复:
 *   - [CRITICAL] 全局超时 90s → 150s（覆盖 DeepSeek 120s）
 *   - [CRITICAL] NeoData 超时 40s → 20s（更快 fallback 到纯 LLM）
 *   - [BUG] _existsSync 函数逻辑错误修复
 *   - [COMPAT] 移除 response_format（deepseek-v4-pro 可能不支持）
 *   - [UX] 增强错误消息可读性
 * ============================================
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const { spawn } = require('child_process');
const https = require('https');
const os = require('os');

// ==================== 配置 ====================
const PORT = process.env.PORT || 3210;

function resolveUserHome() {
  const winPaths = ['C:\\Users\\龚鹏文'];
  for (const p of winPaths) {
    if (fsExistsSync(p) && fsExistsSync(path.join(p, '.workbuddy', 'models.json'))) return p;
  }
  const osHome = os.homedir();
  if (osHome && fsExistsSync(path.join(osHome, '.workbuddy'))) return osHome;
  for (const p of [process.env.USERPROFILE, process.env.HOME].filter(Boolean)) {
    if (p && fsExistsSync(path.join(p, '.workbuddy'))) return p;
  }
  return osHome || '';
}

function fsExistsSync(p) {
  try { return require('fs').existsSync(p); } catch (_) { return false; }
}

const USER_HOME = resolveUserHome();
console.log(`[Config] User Home: ${USER_HOME}`);

// ---- DeepSeek API 配置 ----
let DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
let DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
let DEEPSEEK_MODEL = 'deepseek-v4-pro';

try {
  const fs = require('fs');
  const modelsPath = path.join(USER_HOME, '.workbuddy', 'models.json');
  if (fs.existsSync(modelsPath)) {
    const models = JSON.parse(fs.readFileSync(modelsPath, 'utf-8'));
    const dsModel = models.find(m => m.vendor === 'DeepSeek' || m.id?.includes('deepseek'));
    if (dsModel) {
      DEEPSEEK_API_KEY = dsModel.apiKey || DEEPSEEK_API_KEY;
      DEEPSEEK_API_URL = dsModel.url || DEEPSEEK_API_URL;
      DEEPSEEK_MODEL = dsModel.id || DEEPSEEK_MODEL;
      console.log(`[Config] ✓ DeepSeek: model=${DEEPSEEK_MODEL}`);
    }
  }
} catch (e) {
  console.warn(`[Config] ⚠ models.json 加载失败: ${e.message}`);
}
if (!DEEPSEEK_API_KEY) console.warn('[WARN] ✗ DeepSeek API Key 未配置');

// ---- Python ----
function resolvePython() {
  if (process.env.PYTHON) return process.env.PYTHON;
  const candidates = [
    'C:/ProgramData/WorkBuddy/chromium-env/6w8zcp/.workbuddy/binaries/python/versions/3.13.12/python.exe',
    path.join(os.homedir(), '.workbuddy/binaries/python/versions/3.13.12/python.exe'),
    'python', 'python3',
  ];
  for (const c of candidates) {
    if (c === 'python' || c === 'python3') return c;
    if (fsExistsSync(c)) return c;
  }
  return 'python';
}
const PYTHON_EXE = resolvePython();


// ==================== Express 初始化 ====================
const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));

// 日志
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const icon = res.statusCode < 400 ? '✓' : '✗';
    console.log(`[${new Date().toISOString()}] ${icon} ${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// 🔥 FIX #1: 全局超时 90s → 150s（必须 > DeepSeek 的 120s）
// SSR 报告路由不受此限制（渲染时间可更长）
app.use((req, res, next) => {
  if (req.path === '/report' || req.path.startsWith('/report?')) return next(); // SSR skip
  req.setTimeout(150_000, () => {
    if (!res.headersSent) {
      console.warn('[TIMEOUT] 请求超过 150s，强制关闭');
      res.status(504).json({ error: '分析超时，请简化股票名称后重试（如用代码代替全称）' });
    }
  });
  next();
});


// ==================== 路由 ====================

// GET 路由：服务端渲染报告（零fetch依赖，兼容受限浏览器）
app.get('/report', async (req, res) => {
  const query = (req.query.stock || req.query.q || '').trim();
  if (!query) return res.status(400).send('缺少stock参数，例如 /report?stock=贵州茅台');
  req.body = { stock: query };
  await handleAnalyzeSSR(req, res);
});

app.post('/api/analyze', handleAnalyzeJSON);

app.get('/api/stock', async (req, res) => {
  const query = req.query.query?.trim();
  if (!query) return res.status(400).json({ error: '缺少 query 参数' });
  req.body = { stock: query };
  await handleAnalyzeJSON(req, res);
});

async function handleAnalyzeJSON(req, res) {
  const { stock } = req.body;
  if (!stock?.trim()) return res.status(400).json({ error: '请输入股票名称或代码' });

  const query = stock.trim();
  console.log(`\n${'═'.repeat(56)}\n[Analyze] "${query}"\n${'═'.repeat(56)}`);

  try {
    // Step 1: 数据采集（快速失败）
    let rawData = null;
    try {
      rawData = await fetchFromNeoData(query);
      console.log(`[1/3] ✓ NeoData OK`);
    } catch (neErr) {
      console.log(`[1/3] ⚠ NeoData 跳过 (${neErr.message})`);
      rawData = null; // 快速降级，不阻塞
    }

    // Step 2: DeepSeek 分析（带重试：JSON 解析失败时重试一次）
    console.log(`[2/3] ⟳ DeepSeek 分析...`);
    let analysisResult;
    try {
      analysisResult = await analyzeWithDeepSeek(query, rawData);
      console.log(`[2/3] ✓ DeepSeek OK`);
    } catch (dsErr) {
      // JSON 解析失败 → 重试一次（用更简短的 prompt）
      if (dsErr.message.includes('JSON')) {
        console.log(`[2/3] ⚠ JSON 解析失败，重试中...`);
        try {
          analysisResult = await analyzeWithDeepSeek(query, rawData, true); // retry=true
          console.log(`[2/3] ✓ DeepSeek 重试成功`);
        } catch (retryErr) {
          // 重试也失败 → 返回默认分析
          console.log(`[2/3] ✗ 重试失败: ${retryErr.message}`);
          analysisResult = getDefaultFullAnalysis();
          console.log(`[2/3] ⚠ 使用 LLM 回退数据`);
        }
      } else {
        analysisResult = getDefaultFullAnalysis();
        console.log(`[2/3] ⚠ 非JSON错误: ${dsErr.message}，使用回退数据`);
      }
    }

    // Step 3: 返回
    console.log(`[3/3] ✓ Done`);
    res.json({
      success: true,
      stock: query,
      timestamp: new Date().toISOString(),
      dataSource: rawData ? 'neodata' : 'deepseek-knowledge',
      ...analysisResult,
    });

  } catch (err) {
    // 友好化错误消息
    let userMsg = err.message;
    if (userMsg.includes('DeepSeek API')) userMsg = 'AI 分析服务暂时繁忙，请稍后重试';
    else if (userMsg.includes('timeout') || userMsg.includes('超时')) userMsg = '分析超时，请使用简短股票名（如"茅台"而非完整描述）重试';
    else if (userMsg.includes('JSON 解析')) userMsg = '数据解析异常，请重试';

    console.error(`[ERROR] ${err.message}`);
    res.status(err.status || 500).json({ error: userMsg });
  }
}

/** 服务端渲染版：返回完整HTML，零fetch依赖 */
async function handleAnalyzeSSR(req, res) {
  const { stock } = req.body;
  const query = stock.trim();
  console.log(`\n${'═'.repeat(56)}\n[SSR] "${query}"\n${'═'.repeat(56)}`);

  try {
    let rawData = null;
    try { rawData = await fetchFromNeoData(query); console.log(`[1/3] ✓ NeoData`); }
    catch (neErr) { console.log(`[1/3] ⚠ NeoData skip: ${neErr.message}`); }

    console.log(`[2/3] ⟳ DeepSeek...`);
    let result;
    try { result = await analyzeWithDeepSeek(query, rawData); console.log(`[2/3] ✓`); }
    catch (dsErr) {
      if (dsErr.message.includes('JSON')) {
        console.log(`[2/3] ⚠ retry...`);
        try { result = await analyzeWithDeepSeek(query, rawData, true); }
        catch (_) { result = getDefaultFullAnalysis(); }
      } else { result = getDefaultFullAnalysis(); }
    }

    res.send(renderReportHTML(query, result, rawData ? 'neodata' : 'deepseek'));
    console.log(`[3/3] ✓ SSR rendered`);
  } catch (err) {
    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px">
      <h2>分析失败</h2><p>${err.message}</p>
      <a href="/" style="color:#c0956b">← 返回</a></body></html>`);
  }
}

function renderReportHTML(query, d, dataSource) {
  const v = d.conclusion?.verdict || '中性';
  const chg = d.basic?.changePct;
  const events = (d.events||[]).sort((a,b)=> a.type==='positive'?-1:a.type==='negative'?1:0);
  const ds = dataSource === 'neodata' ? 'NeoData + DeepSeek' : 'DeepSeek';
  const stars = Array.from({length:5},(_,i)=>i<(d.alpha?.stars||0)?'★':'☆').join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Serenity - ${d.basic?.name||query}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
<style>
:root{--bg:#faf7f0;--card:#fff;--cb:rgba(180,160,130,.15);--t:#2d2a24;--tm:#9b9488;--g:#4a9b6d;--r:#c5554a;--o:#d4944a;--a:#c0956b;--f:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--t);font-family:var(--f);min-height:100vh;line-height:1.6}
body::before{content:'';position:fixed;inset:-50%;background:radial-gradient(ellipse at 20% 50%,rgba(180,160,130,.06),transparent 50%),radial-gradient(ellipse at 80% 20%,rgba(140,180,160,.04),transparent 50%);pointer-events:none;z-index:0}
.header{position:sticky;top:0;z-index:100;background:rgba(250,247,240,.88);backdrop-filter:blur(20px);border-bottom:1px solid var(--cb);padding:14px 28px;display:flex;align-items:center;justify-content:space-between}
.brand{display:flex;align-items:center;gap:10px}
.brand-icon{width:32px;height:32px;border-radius:8px;background:linear-gradient(135deg,#c0956b,#d4b896);display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px;font-weight:700}
.header a{font-size:14px;color:var(--a);text-decoration:none;font-weight:600}
.main{max-width:1000px;margin:0 auto;padding:32px 24px 60px;position:relative;z-index:1}
.report{display:grid;gap:16px}
.rh{display:flex;align-items:center;justify-content:space-between;background:linear-gradient(135deg,#fefcf7,#faf7f0);border:1px solid var(--cb);border-radius:16px;padding:22px 28px;box-shadow:0 2px 12px rgba(0,0,0,.05)}
.sn{font-size:24px;font-weight:700;display:flex;align-items:center;gap:10px}
.pc{padding:3px 10px;border-radius:16px;font-size:12px;font-weight:600;background:${(chg||0)>=0?'rgba(197,85,74,.08)':'rgba(74,155,109,.08)'};color:${(chg||0)>=0?'var(--r)':'var(--g)'}}
.sm{display:flex;gap:8px;color:var(--tm);font-size:12px;margin-top:4px}
.vb{padding:10px 22px;border-radius:20px;font-size:14px;font-weight:700}
.vb-buy{background:rgba(74,155,109,.08);color:var(--g)}
.vb-c{background:rgba(212,148,74,.08);color:var(--o)}
.vb-n{background:rgba(107,101,96,.06);color:#6b6560}
.row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:768px){.row{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--cb);border-radius:16px;padding:22px 24px;box-shadow:0 2px 12px rgba(0,0,0,.05)}
.ch{display:flex;align-items:center;gap:10px;margin-bottom:18px}
.ci{width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;background:rgba(192,149,107,.08);font-size:14px}
.ct{font-size:14px;font-weight:700}
.mg{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.mi{padding:12px 14px;background:#fefcf7;border-radius:10px;border:1px solid var(--cb)}
.ml{font-size:10px;color:var(--tm);text-transform:uppercase;margin-bottom:3px}
.mv{font-size:17px;font-weight:700;font-family:monospace}
.cv{height:200px}
.pd{text-align:center;padding:14px;background:#fefcf7;border-radius:10px}
.pd strong{font-size:22px;font-family:monospace}
.sub{color:var(--tm);font-size:12px;margin-top:4px}
.gs{text-align:center;margin-bottom:14px}
.gn{font-size:52px;font-weight:800;font-family:monospace;line-height:1}
.gl{font-size:16px;color:var(--tm)}
.gv{text-align:center;font-size:13px;font-weight:600;padding:8px}
.bc{height:240px}
.bp{text-align:center;padding:12px;background:#fefcf7;border-radius:10px;font-size:13px}
.ar{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.ast{display:flex;gap:3px;font-size:22px;color:var(--a)}
.av{font-weight:700;font-family:monospace}
.ae{display:grid;gap:8px}
.ei{padding:10px 14px;border-radius:10px;font-size:12px;display:flex;gap:8px;align-items:center;background:#fefcf7}
.ep{border-left:3px solid var(--g)}
.en{border-left:3px solid var(--r)}
.ee{border-left:3px solid #d4cfc6}
.et{font-size:10px;padding:2px 8px;border-radius:10px;white-space:nowrap;font-weight:500}
.etp{background:rgba(74,155,109,.08);color:var(--g)}
.etn{background:rgba(197,85,74,.08);color:var(--r)}
.ete{background:rgba(107,101,96,.06);color:var(--tm)}
.cb2{font-size:13px;line-height:1.8}
.cb2 p{margin-bottom:10px}
.cb2 ul{list-style:none;margin:6px 0}
.cb2 ul li{padding:5px 0}
.bl li::before{content:"✦";color:var(--g);margin-right:6px}
.brl li::before{content:"▸";color:var(--r);margin-right:6px}
.foot{text-align:center;padding:20px;color:var(--tm);font-size:11px}
</style>
</head>
<body>
<div class="header">
  <div class="brand"><div class="brand-icon">S</div><div><b>Serenity 投研报告</b><br><span style="font-size:11px;color:var(--tm);font-weight:400">${d.basic?.name||query} · ${ds}</span></div></div>
  <a href="/">← 分析其他</a>
</div>
<div class="main">
<div class="report">

<div class="rh">
  <div>
    <h2 class="sn">${d.basic?.name||query}<span class="pc">${chg!=null?(chg>=0?'+':'')+chg+'%':'--'}</span></h2>
    <div class="sm"><span>${d.basic?.code||'--'}</span> · <span>${new Date().toLocaleDateString('zh-CN')}</span></div>
  </div>
  <div class="vb vb-${v==='买入'?'buy':v==='谨慎'||v==='观察'?'c':'n'}">${v}</div>
</div>

<div class="row">
  <div class="card">
    <div class="ch"><div class="ci">◈</div><div class="ct">核心指标</div></div>
    <div class="mg">
      ${[['最新价',d.basic?.price||'--'],['市值(亿)',d.basic?.marketCap||'--'],['PE(TTM)',d.valuation?.peTTM||'--'],['Fwd PE',d.valuation?.forwardPE||'--'],['PB',d.valuation?.pb||'--'],['营收增速',(d.financials?.revenueGrowth||'--')+'%'],['毛利率',(d.financials?.grossMargin||'--')+'%'],['ROE',(d.financials?.roe||'--')+'%']].map(([l,v])=>'<div class="mi"><div class="ml">'+l+'</div><div class="mv">'+v+'</div></div>').join('')}
    </div>
  </div>
  <div class="card">
    <div class="ch"><div class="ci">◎</div><div class="ct">TAM-Adj-PEG</div></div>
    <div class="cv"><canvas id="c1"></canvas></div>
    <div class="pd">
      <strong style="color:${d.peg?.color||'var(--o)'}">PEG = ${d.peg?.pegValue||'--'}</strong>
      <div class="sub">${d.peg?.grade||'--'} · ${d.peg?.advice||''}</div>
    </div>
  </div>
</div>

<div class="row">
  <div class="card">
    <div class="ch"><div class="ci">⬡</div><div class="ct">GF-DMA 健康度</div></div>
    <div class="gs"><span class="gn" style="color:${d.gfDma?.zoneColor||'var(--o)'}">${d.gfDma?.total||'--'}</span><span class="gl">/100</span></div>
    <div class="cv"><canvas id="c2"></canvas></div>
    <div class="gv">${d.gfDma?.zone||'--'}: ${d.gfDma?.verdict||''}</div>
  </div>
  <div class="card">
    <div class="ch"><div class="ci">∞</div><div class="ct">贝叶斯估值</div></div>
    <div class="bc"><canvas id="c3"></canvas></div>
    <div class="bp">内在 <b>${d.bayesian?.intrinsicGrowth||'--'}%</b> vs 隐含 <b>${d.bayesian?.impliedGrowth||'--'}%</b>${d.bayesian?.conclusion?'<br><span style="color:'+(parseFloat(d.bayesian.diff||0)>=0?'var(--g)':'var(--r)')+'">→ '+d.bayesian.conclusion+' ('+(d.bayesian.dominantHypothesis||'')+')</span>':''}</div>
  </div>
</div>

<div class="row">
  <div class="card">
    <div class="ch"><div class="ci">✦</div><div class="ct">Alpha 信号</div></div>
    <div class="ar"><span style="font-size:13px;color:var(--tm)">强度</span><span class="ast">${stars}</span><span class="av">${d.alpha?.score||'--'}/5</span></div>
    <div class="ae">${events.map(e=>'<div class="ei e'+(e.type==='positive'?'p':e.type==='negative'?'n':'e')+'"><span class="et et'+(e.type==='positive'?'p':e.type==='negative'?'n':'e')+'">'+e.tag+'</span>'+e.desc+'</div>').join('')}</div>
  </div>
  <div class="card">
    <div class="ch"><div class="ci">⌂</div><div class="ct">综合建议</div></div>
    <div class="cb2">
      <p style="color:var(--tm)">${d.conclusion?.summary||'--'}</p>
      <p style="font-weight:700;font-size:12px;color:var(--g)">利好</p><ul class="bl">${(d.conclusion?.bullCase||[]).map(c=>'<li>'+c+'</li>').join('')}</ul>
      <p style="font-weight:700;font-size:12px;color:var(--r);margin-top:12px">风险</p><ul class="brl">${(d.conclusion?.bearCase||[]).map(c=>'<li>'+c+'</li>').join('')}</ul>
      <p style="margin-top:12px;padding:12px;background:#fefcf7;border-radius:8px"><b>建议:</b> ${d.conclusion?.positionAdvice||'--'}</p>
    </div>
  </div>
</div>

</div>
<div class="foot">Serenity 投研工具箱 · 仅供参考不构成投资建议</div>
</div>
<script>
${buildSSRChartJS(d)}
</script>
</body></html>`;
}

function buildSSRChartJS(d) {
  return `setTimeout(function(){
if(typeof Chart==='undefined')return;
// PEG
var c1=document.getElementById('c1');
if(c1){var ctx=c1.getContext('2d'),pv=Math.min(Math.max(parseFloat('${d.peg?.pegValue||2}')||2,0),4);
new Chart(ctx,{type:'bar',data:{labels:['PEG'],datasets:[
  {label:'低估',data:[.8],backgroundColor:'rgba(74,155,109,.2)',barPercentage:1,categoryPercentage:1,base:0},
  {label:'偏低',data:[.4],backgroundColor:'rgba(74,155,109,.1)',barPercentage:1,categoryPercentage:1,base:.8},
  {label:'合理',data:[.6],backgroundColor:'rgba(212,148,74,.1)',barPercentage:1,categoryPercentage:1,base:1.2},
  {label:'偏贵',data:[.7],backgroundColor:'rgba(197,85,74,.1)',barPercentage:1,categoryPercentage:1,base:1.8},
  {label:'高估',data:[1.5],backgroundColor:'rgba(197,85,74,.2)',barPercentage:1,categoryPercentage:1,base:2.5},
  {label:'当前',data:[1],backgroundColor:'${d.peg?.color||'var(--o)'}',borderColor:'#fff',borderWidth:2,borderRadius:6,barPercentage:.06,categoryPercentage:1,base:pv}
]},options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,scales:{x:{min:0,max:4,grid:{display:false},ticks:{stepSize:.5,color:'#9b9488'}},y:{display:false}},plugins:{legend:{display:false}}}})}
// GF
var c2=document.getElementById('c2');
var dims=${JSON.stringify(d.gfDma?.dims||[{label:'--',value:0,max:40}])};
if(c2){new Chart(c2.getContext('2d'),{type:'radar',data:{labels:dims.map(function(di){return di.label}),datasets:[{data:dims.map(function(di){return(di.value/di.max)*100}),backgroundColor:'rgba(192,149,107,.12)',borderColor:'#c0956b',borderWidth:2,pointRadius:4,pointBackgroundColor:'#c0956b'}]},options:{responsive:true,maintainAspectRatio:false,scales:{r:{min:0,max:100,ticks:{display:false},grid:{color:'rgba(0,0,0,.06)'},pointLabels:{color:'#6b6560',font:{size:11}}}},plugins:{legend:{display:false}}}})}
// Bayes
var c3=document.getElementById('c3');
var hyps=${JSON.stringify(d.bayesian?.hypotheses||[])};
if(c3){new Chart(c3.getContext('2d'),{type:'bar',data:{labels:hyps.map(function(h){return h.label}),datasets:[{data:hyps.map(function(h){return h.posterior}),backgroundColor:['#c5554a','#d4944a','#d4b896','#5b9b6d','#5b8db8','#8b7ec8'],borderRadius:4}]},options:{responsive:true,maintainAspectRatio:false,scales:{x:{grid:{display:false},ticks:{color:'#9b9488',font:{size:9}}},y:{display:false}},plugins:{legend:{display:false}}}})}
},200);`;
}

async function analyzeWithDeepSeek(stockQuery, rawData, isRetry = false) {
  const prompt = buildAnalysisPrompt(stockQuery, rawData, isRetry);

  const resp = await fetch(DEEPSEEK_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: 'system', content: SERENITY_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 6000,
      // 🔥 FIX #3: 移除 response_format（deepseek-v4-pro 可能不支持 OpenAI 扩展参数）
      // response_format: { type: 'json_object' },  // 已移除
    }),
    signal: AbortSignal.timeout(130_000), // 给全局 150s 留余量
  });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    throw new Error(`DeepSeek API 错误 ${resp.status}: ${errBody.slice(0, 300)}`);
  }

  const result = await resp.json();
  const content = result.choices?.[0]?.message?.content;
  if (!content) throw new Error('DeepSeek 返回内容为空');

  // 解析 JSON（多策略：兼容各种 DeepSeek 返回格式）
  let parsed = extractJSON(content);
  if (!parsed) throw new Error(`JSON 解析失败: ${content.slice(0, 300)}`);

  // 补全缺失字段
  ['peg', 'gfDma', 'bayesian', 'alpha'].forEach(f => {
    if (!parsed[f]) { parsed[f] = getDefaultAnalysis(f); console.warn(`  [补全 ${f}]`); }
  });

  return parsed;
}


// ==================== JSON 解析工具 ====================

/**
 * 多策略 JSON 提取：兼容 DeepSeek 各种非标准返回格式
 * 策略顺序:
 *   1. 直接 JSON.parse
 *   2. 提取 ```json ... ``` 代码块
 *   3. 提取 ``` ... ``` 代码块（无语言标记）
 *   4. 查找最外层 { ... } 配对
 *   5. 修复常见 JSON 语法错误后重试
 */
function extractJSON(content) {
  let text = content.trim();

  // 策略 1: 直接解析
  try { return JSON.parse(text); } catch (_) {}

  // 策略 2: ```json ... ```
  let m = text.match(/```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```/);
  if (m) {
    try { return JSON.parse(m[1].trim()); } catch (_) {}
  }

  // 策略 3: 查找 { 和 } 配对（取最外层完整 JSON 对象）
  const firstBrace = text.indexOf('{');
  if (firstBrace >= 0) {
    let depth = 0, inString = false, escape = false;
    for (let i = firstBrace; i < text.length; i++) {
      const ch = text[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) {
        const candidate = text.substring(firstBrace, i + 1);
        try { return JSON.parse(candidate); } catch (_) { break; }
      }}
    }
  }

  // 策略 4: 修复常见错误后重试（去掉尾部逗号、修复单引号、修复无引号 key）
  let fixed = text;
  // 如果内容以 { 开头，尝试各种修复
  if (fixed.startsWith('{') || (m && m[1])) {
    const tryFix = (s) => { try { return JSON.parse(s); } catch (_) { return null; }};

    // 去掉尾部逗号
    let r = tryFix(fixed.replace(/,(\s*[}\]])/g, '$1'));
    if (r) return r;

    // 提取到第一个完整的 JSON 块
    const braceIdx = fixed.indexOf('{');
    if (braceIdx >= 0) {
      // 尝试越来越短的尾巴
      for (let end = fixed.length; end > braceIdx + 10; end--) {
        r = tryFix(fixed.substring(braceIdx, end));
        if (r) return r;
      }
    }
  }

  return null;
}

function buildAnalysisPrompt(stockQuery, rawData, isRetry = false) {
  let dataSection = '';
  if (rawData && Object.keys(rawData).length > 0) {
    dataSection = `\n## 已获取到的原始数据：\n\`\`\`json\n${JSON.stringify(rawData, null, 2)}\n\`\`\``;
  } else {
    dataSection = `\n⚠️ 未能获取实时数据，请基于你的知识库对「${stockQuery}」进行尽可能准确的分析。`;
  }

  // 重试模式使用更紧迫的语气
  const retryPrefix = isRetry
    ? '【重试 - 请务必只输出纯JSON，不要任何解释】'
    : '严格按 JSON 格式输出（不要输出任何其他文字，直接输出 JSON 对象）：';

  return `请对以下股票进行完整的四维投研分析：

**目标**: ${stockQuery}
**日期**: ${new Date().toLocaleDateString('zh-CN')}
${dataSection}

${retryPrefix}
{
  "basic": {"name":"公司名","code":"代码","price":最新价,"changePct":涨跌幅%,"marketCap":市值亿,"currency":"CNY|USD"},
  "valuation": {"peTTM":PE,"forwardPE":FPE,"pb":PB,"ps":PS},
  "financials":{"revenue":营收亿,"revenueGrowth":营收增速%,"netProfit":净利亿,"profitGrowth":利润增速%,"grossMargin":毛利率%,"netMargin":净利率%,"roe":ROE%,"debtRatio":负债率%,"operatingCF":现金流亿,"rdExpense":研发费亿,"rdRatio":研发占比%},
  "technical":{"ma5":5日均线,"ma20":20日均线,"ma60":60日均线,"ma120":120日均线,"ma250":250日均线,"priceVsMa20":偏离度%,"atr":ATR,"volumeRatio":量比,"rsi14":RSI},
  "analyst":{"ratingBuy":买入%,"targetPriceHigh":目标价高,"targetPriceLow":目标价低,"consensusEPS2025":2025EPS,"consensusEPS2026":2026EPS,"impliedGrowthRate":隐含增速%},
  "industry":{"sectorName":"行业","industryTAM":TAM亿美元,"tamCAGR":CAGR%,"companyMarketShare":市占率%,"competitivePosition":"竞争地位"},
  "events":[{"type":"positive|negative|neutral","tag":"标签","desc":"描述"},...至少4条],
  "peg":{"forwardPE":FPE,"epsGrowth":"EPS增速%","trf":"TRF","qf":"QF","adjustedGR":"修正增速%","pegValue":"PEG值","grade":"深度低估|低估|合理偏低|偏贵|高估泡沫","color":"#hex","advice":"建议"},
  "gfDma":{"total":0-100,"dims":[{"label":"基本面匹配","value":分,"max":40},{"label":"股价背离度","value":分,"max":25},{"label":"趋势平行性","value":分,"max":20},{"label":"预期修正","value":分,"max":15}],"zone":"Healthy Uptrend|Neutral Zone|Caution Area|High Risk Escape","zoneColor":"#hex","verdict":"判定"},
  "bayesian":{"hypotheses":[{"id":"H0","label":"衰退收缩","rate":-5,"posterior":0-1概率},{"id":"H1","label":"低增长","rate":5,"posterior":概率},{"id":"H2","label":"稳健增长","rate":12,"posterior":概率},{"id":"H3","label":"高增长","rate":22,"posterior":概率},{"id":"H4","label":"爆发式","rate":36,"posterior":概率},{"id":"H5","label":"平台扩张","rate":52,"posterior":概率}],"intrinsicGrowth":"内在增速%","impliedGrowth":"隐含增速%","diff":"差值%","conclusion":"结论","dominantHypothesis":"主导假设"},
  "alpha":{"score":"分数如3.5","stars":1-5,"events":[同上],"verdict":"结论"},
  "conclusion":{"summary":"三句总结","bullCase":["利好1",...],"bearCase":["风险1",...],"verdict":"买入|中性|谨慎|观察","positionAdvice":"仓位建议"}
}`;
}

const SERENITY_SYSTEM_PROMPT = `你是专业量化投研分析师。对指定股票执行四维分析并返回纯JSON对象（不要markdown代码块标记，不要任何解释文字）。

### 1. TAM-Adj-PEG
公式: PEG = ForwardPE/(EPS增速×TRF×QF)
TRF(CAGR≥15%→1.25; 10-15→1.05; 6-10→0.85; <6→0.6)
QF(毛利率≥55%→1.2; 45-55→1.05; 35-45→0.9; <35→0.75)
评级:<0.8深度低估 0.8-1.2低估 1.2-1.8合理 1.8-2.5偏贵 >2.5高估

### 2. GF-DMA (总分100)
基本面匹配40 + 股价背离25 + 趋势平行20 + 预期修正15
≥78 Healthy; 58-77 Neutral; 38-57 Caution; <38 High Risk

### 3. 贝叶斯估值
H0(-5%)~H5(+52%), 六个假设后验概率分布
差值>+8%显著低估; +3%~+8%温和低估; -3%~+3%合理; -8%~-3%温和高估; <-8%显著高估

### 4. Alpha事件驱动
0-5分, 正面+0.7/负面-0.6/中性+0.2, 营收>30%+0.6
≥4强Alpha; 3-4中等; 2-3弱; <2无Alpha

规则:
1. 直接返回JSON对象，不要用代码块标记包裹
2. 数值必须为有效数字，不可为null/空字符串
3. A股涨=红(#ef4444), 跌=绿(#10b981)
4. events至少4条，混合positive/negative/neutral
5. 结论客观有数据支撑`;


// ==================== NeoData 数据获取 ====================

function fetchFromNeoData(query) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.resolve(USER_HOME, '.workbuddy/skills/skill_2053082432761950208/scripts/query.py');
    const workDir = path.resolve(USER_HOME, '.workbuddy/skills/skill_2053082432761950208');

    if (!fsExistsSync(scriptPath)) return reject(new Error('脚本不存在'));

    // 🔥 FIX #2: NeoData 超时从 40s → 20s（更快 fallback）
    const proc = spawn(PYTHON_EXE, [scriptPath, '--query', query, '--data-type', 'api'], {
      cwd: workDir, timeout: 20000, shell: false, windowsHide: true,
      env: { ...process.env },
    });

    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());

    proc.on('close', code => {
      const output = stdout.trim();
      if (code !== 0 || !output) return reject(new Error(`退出码${code}: ${(stderr||output||'(空)').slice(0,200)}`));
      try {
        const match = output.match(/\{[\s\S]*\}/);
        resolve(match ? JSON.parse(match[0]) : { _rawText: output.slice(0, 2000) });
      } catch (e) { reject(new Error(`JSON解析: ${e.message}`)); }
    });

    proc.on('error', err => reject(new Error(`Python错误: ${err.message}`)));
    setTimeout(() => { try { proc.kill(); } catch (_) {} reject(new Error('数据获取超时')); }, 20000); // 20s 超时
  });
}


// ==================== Fallback 默认值 ====================
function getDefaultAnalysis(frame) {
  const defaults = {
    peg: { forwardPE:'30', epsGrowth:'15%', trf:'0.85', qf:'0.9', adjustedGR:'11.5%', pegValue:'2.61', grade:'偏贵', color:'#ef4444', advice:'观望等待更好价格' },
    gfDma: { total:50, dims:[{label:'基本面匹配',value:25,max:40},{label:'股价背离度',value:12,max:25},{label:'趋势平行性',value:8,max:20},{label:'预期修正',value:5,max:15}], zone:'Neutral Zone', zoneColor:'#f59e0b', verdict:'数据不足' },
    bayesian: { hypotheses:[{id:'H0',label:'衰退收缩',rate:-5,posterior:.05},{id:'H1',label:'低增长',rate:5,posterior:.15},{id:'H2',label:'稳健增长',rate:12,posterior:.30},{id:'H3',label:'高增长',rate:22,posterior:.30},{id:'H4',label:'爆发式',rate:36,posterior:.15},{id:'H5',label:'平台扩张',rate:52,posterior:.05}], intrinsicGrowth:'14.2', impliedGrowth:'18.5', diff:'-4.3', conclusion:'定价基本反映内在价值', dominantHypothesis:'稳健增长' },
    alpha: { score:'2.5', stars:3, events:[{type:'neutral',tag:'关注',desc:'暂无特别催化事件'}], verdict:'无明显超额收益机会' },
  };
  return defaults[frame];
}

/** 当 DeepSeek 完全不可用时，返回完整的降级分析数据 */
function getDefaultFullAnalysis() {
  return {
    basic: { name: '数据获取中', code: '--', price: 0, changePct: 0, marketCap: 0, currency: 'CNY' },
    valuation: { peTTM: 0, forwardPE: 0, pb: 0, ps: 0 },
    financials: { revenue: 0, revenueGrowth: 0, netProfit: 0, profitGrowth: 0, grossMargin: 0, netMargin: 0, roe: 0, debtRatio: 0, operatingCF: 0, rdExpense: 0, rdRatio: 0 },
    technical: { ma5: 0, ma20: 0, ma60: 0, ma120: 0, ma250: 0, priceVsMa20: 0, atr: 0, volumeRatio: 0, rsi14: 50 },
    analyst: { ratingBuy: 0, targetPriceHigh: 0, targetPriceLow: 0, consensusEPS2025: 0, consensusEPS2026: 0, impliedGrowthRate: 0 },
    industry: { sectorName: '--', industryTAM: 0, tamCAGR: 0, companyMarketShare: 0, competitivePosition: '--' },
    events: [{ type: 'neutral', tag: '提示', desc: 'AI 分析服务暂时不可用，请稍后重试' }],
    peg: getDefaultAnalysis('peg'),
    gfDma: getDefaultAnalysis('gfDma'),
    bayesian: getDefaultAnalysis('bayesian'),
    alpha: getDefaultAnalysis('alpha'),
    conclusion: {
      summary: 'AI 分析引擎暂时无法提供服务。默认数据显示仅供参考，不代表实际投资建议。',
      bullCase: ['请稍后重试获取完整分析'],
      bearCase: ['当前返回的是降级备份数据'],
      verdict: '数据不可用',
      positionAdvice: '建议等待服务恢复后再做决策'
    }
  };
}


// ==================== 健康检查 & 静态文件 ====================

app.get('/api/health', (_req, res) => res.json({
  status: 'ok', timestamp: new Date().toISOString(),
  deepseek: DEEPSEEK_API_KEY ? 'configured' : 'MISSING',
  model: DEEPSEEK_MODEL, python: PYTHON_EXE.split('/').pop() || PYTHON_EXE,
}));

app.use(express.static(__dirname));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));


// ==================== 启动 ====================
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║   Serenity 投研报告生成器 v3.1 (Hotfix)      ║
║   http://localhost:${PORT}                        ║
╚══════════════════════════════════════════════╝
  DeepSeek: ${DEEPSEEK_MODEL} ${DEEPSEEK_API_KEY ? '✓' : '✗'}
  Python:  ${PYTHON_EXE.split('/').pop() || PYTHON_EXE}
  Timeout: 150s (Global) | 130s (DeepSeek) | 20s (NeoData)
  APIs:    POST /api/analyze | GET /api/health
  `);
});
