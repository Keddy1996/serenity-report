# Serenity 投研报告生成器

四维量化分析引擎 — 输入股票名称，一键生成专业投研报告。

## 功能

基于四个量化框架，对任意股票进行全维度分析：

| 框架 | 说明 | 输出 |
|------|------|------|
| **TAM-Adj-PEG** | 用市场规模（TAM）和质量因子修正传统 PEG | 估值区间 + 买卖建议 |
| **GF-DMA** | 四维加权趋势健康度评分（基本面/背离/趋势/预期） | 0-100 分 + 区域判定 |
| **贝叶斯估值** | H0-H5 六假设后验概率分布 | 内在增速 vs 市场隐含增速 |
| **Serenity Alpha** | 事件驱动 Alpha 信号扫描 | 0-5 分 + 事件列表 |

## 架构

```
浏览器 ──→ Express SSR ──→ NeoData 实时行情
                │
                └──→ DeepSeek v4 量化分析
```

- **SSR 模式（推荐）**：`/report?stock=贵州茅台` — 服务端渲染，零浏览器 fetch 依赖
- **JSON API**：`POST /api/analyze` — 返回完整结构化数据
- **独立版**：`standalone.html` — 浏览器直连 DeepSeek（备选方案）

## 快速开始

```bash
# 1. 克隆仓库
git clone https://github.com/Keddy1996/serenity-report.git
cd serenity-report

# 2. 安装依赖
npm install

# 3. 配置 DeepSeek API Key
# 编辑 server.js 或在环境变量中设置 DEEPSEEK_API_KEY

# 4. 启动
node server.js

# 5. 打开浏览器
# http://localhost:3210
```

## 使用方式

### 网页界面
1. 打开 `http://localhost:3210`
2. 输入股票名称（如「贵州茅台」「中芯国际」「NVDA」）
3. 点击「开始分析」
4. 等待 30-60 秒，查看四维分析报告
5. 点击「导出高清图片」— 一键复制到剪贴板分享

### API 接口
```bash
curl -X POST http://localhost:3210/api/analyze \
  -H "Content-Type: application/json" \
  -d '{"stock":"贵州茅台"}'
```

### SSR 直接链接
```
http://localhost:3210/report?stock=贵州茅台
http://localhost:3210/report?stock=NVDA
```

## 项目结构

```
serenity-report/
├── index.html              # 首页（暖色搜索界面）
├── server.js               # Express 后端（API + SSR）
├── standalone.html         # 独立版（浏览器直连 DeepSeek）
├── package.json            # 依赖配置
├── .gitignore
├── css/
│   └── style.css           # 样式表
├── js/
│   └── app.js              # 前端逻辑
└── libs/
    ├── chart.min.js        # Chart.js 图表库
    └── html2pdf.bundle.min.js  # 导出工具
```

## 设计

暖色奶油风（#faf7f0 底色 + 金色点缀），适配桌面和移动端。

- 毛玻璃导航栏 + 呼吸灯状态指示
- Chart.js 四维可视化图表
- html2canvas 高清 PNG 导出 + 一键复制
- 响应式布局，A4 打印优化

## 技术栈

- **后端**：Express (Node.js)
- **AI**：DeepSeek v4 Pro
- **数据**：NeoData 实时行情（可选，失败时自动降级为 AI 知识库）
- **图表**：Chart.js
- **导出**：html2canvas

## License

MIT
