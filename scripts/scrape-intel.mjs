/* ============================================================
   每日情报抓取 · GitHub Actions 用（Node 20+，零依赖）
   ------------------------------------------------------------
   来源 1：Google News RSS（多主题、中英双语检索）
   来源 2：多个国内外汽车/科技媒体的 RSS 直源（按关键词筛选归类）
   抓取「当天/最近」车机体验设计相关资讯，合并去重后写入
   intel-data.json 和 intel-data.js，由每日工作流自动提交。
   无需任何 API Key。
   ============================================================ */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

/* —— 来源 1：Google News 多检索词（中英混合，覆盖国内外厂商）—— */
const TOPICS = [
  { topic: "芯片算力", qs: [
    "智能座舱芯片 座舱SoC 高通 8295 8797", "舱驾一体 芯片 算力 英伟达 Thor 芯擎 黑芝麻",
    "座舱芯片 装机量 份额 出货", "automotive cockpit SoC Qualcomm Snapdragon Nvidia",
    "in-vehicle infotainment chip processor cockpit" ] },
  { topic: "中控仪表", qs: [
    "车载中控屏 仪表 贯穿屏", "座舱显示 车载面板 京东方 天马 维信诺 TCL华星",
    "副驾屏 后排屏 曲面屏 车载显示", "automotive cockpit display LG Samsung BOE pillar-to-pillar",
    "car infotainment screen digital instrument cluster" ] },
  { topic: "HUD", qs: [
    "AR-HUD 抬头显示 量产", "P-HUD 全景抬头显示 一体黑",
    "HUD 华为 泽景 华阳 未来黑科技 光波导", "automotive AR HUD head-up display Valeo Continental",
    "windshield head-up display holographic automotive" ] },
  { topic: "座舱AI", qs: [
    "智能座舱 大模型 AI Agent 上车", "鸿蒙座舱 HarmonySpace Flyme Auto",
    "座舱 语音助手 多模态 交互", "automotive cockpit AI assistant voice LLM",
    "in-car AI agent Android Automotive cockpit" ] },
  { topic: "舱驾一体", qs: [
    "舱驾一体 中央计算", "座舱域控制器 中央计算平台 One-Chip",
    "整车电子电气架构 域控 跨域融合", "automotive central compute domain controller cockpit",
    "software defined vehicle cockpit domain" ] },
];

/* —— 来源 2：媒体 RSS 直源（英文为主，按关键词过滤归类）—— */
const FEEDS = [
  { src: "CnEVPost", url: "https://cnevpost.com/feed/" },
  { src: "CarNewsChina", url: "https://carnewschina.com/feed/" },
  { src: "InsideEVs", url: "https://insideevs.com/rss/articles/all/" },
  { src: "Electrek", url: "https://electrek.co/feed/" },
  { src: "The Verge", url: "https://www.theverge.com/rss/transportation/index.xml" },
];
/* 关键词→主题（按顺序命中，均不命中则视为不相关、丢弃）*/
const CLASS = [
  ["HUD", /\bhud\b|head-?up|抬头显示|光波导|windshield display|holograph/i],
  ["中控仪表", /infotainment|center (screen|display|stack)|instrument cluster|dashboard (screen|display)|pillar-to-pillar|中控屏|仪表(盘|屏)|贯穿屏|副驾屏|车载(屏|显示|面板)|oled.*(car|vehicle|automotive|cockpit)/i],
  ["芯片算力", /snapdragon|qualcomm|nvidia|\bsoc\b|cockpit chip|座舱.*芯片|算力|\btops\b|芯擎|黑芝麻/i],
  ["座舱AI", /cockpit.*\bai\b|in-?car (ai|assistant)|voice assistant|large language model|harmonyos|鸿蒙座舱|座舱.*大模型|语音助手|ai agent/i],
  ["舱驾一体", /central comput|domain controller|software.?defined vehicle|舱驾一体|中央计算|域控/i],
];
function classify(text) { for (const [t, re] of CLASS) if (re.test(text)) return t; return null; }

const DAYS = 7;        // 收最近几天
const PER_QUERY = 10;  // 每个 Google 检索词最多取几条
const PER_FEED = 12;   // 每个媒体源最多取几条
const MAX_ITEMS = 80;  // 数据文件最多保留条数

const isEn = (q) => /[a-z]/i.test(q) && !/[一-鿿]/.test(q);
function gnewsUrl(q) {
  const en = isEn(q);
  const hl = en ? "en-US" : "zh-CN", gl = en ? "US" : "CN", ceid = en ? "US:en" : "CN:zh-Hans";
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:8d")}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
}
function clean(s) {
  return (s || "").replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ").trim();
}
const escRe = (x) => (x || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function parseRss(xml) {
  const out = []; const re = /<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/g; let m;
  while ((m = re.exec(xml))) {
    const b = m[1];
    const pick = (tag) => { const r = new RegExp("<" + tag + "(?:[^>]*)>([\\s\\S]*?)<\\/" + tag + ">").exec(b); return r ? r[1] : ""; };
    let link = clean(pick("link"));
    if (!link) { const lr = /<link[^>]*href="([^"]+)"/.exec(b); if (lr) link = lr[1]; }
    out.push({ title: clean(pick("title")), link, pub: pick("pubDate") || pick("updated") || pick("published"), desc: clean(pick("description") || pick("summary")), src: clean(pick("source")) });
  }
  return out;
}
const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const normKey = (s) => (s || "").toLowerCase().replace(/[^a-z0-9一-鿿]/g, "").slice(0, 60);

async function fetchText(url) {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; intel-bot/1.0)" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.text();
}

async function main() {
  const now = Date.now(), cutoff = now - DAYS * 864e5;
  let existing = { updated: "", note: "", items: [] };
  if (existsSync("intel-data.json")) { try { existing = JSON.parse(readFileSync("intel-data.json", "utf8")); } catch (e) {} }
  if (!Array.isArray(existing.items)) existing.items = [];
  const seenT = new Set(existing.items.map((i) => normKey(i.title)));
  const seenU = new Set(existing.items.map((i) => i.url));
  const fresh = [];
  const push = (topic, it, srcName) => {
    if (!it.title || !it.link) return;
    const t = new Date(it.pub || now).getTime();
    if (isFinite(t) && t < cutoff) return;
    const key = normKey(it.title);
    if (!key || seenT.has(key) || seenU.has(it.link)) return;
    seenT.add(key); seenU.add(it.link);
    const src = it.src || srcName || "News";
    const srcRe = src ? new RegExp("\\s*[-|·–]?\\s*" + escRe(src) + "\\s*$", "i") : null;
    let title = it.title.replace(/\s+[-|]\s+[^-|]+$/, "").trim();
    if (srcRe) title = title.replace(srcRe, "").trim();
    if (title.length > 54) title = title.slice(0, 52) + "…";
    let summary = it.desc && it.desc.length > 12 ? it.desc : it.title;
    summary = summary.replace(/\s+[-|]\s+[^-|]+$/, "").trim();
    if (srcRe) summary = summary.replace(srcRe, "").trim();
    if (!summary || summary.length < 6) summary = title;
    if (summary.length > 100) summary = summary.slice(0, 98) + "…";
    fresh.push({ id: "g" + Math.random().toString(36).slice(2, 8), date: ymd(isFinite(t) ? t : now), topic, title, summary, source: src, url: it.link });
  };

  // 来源 1：Google News
  for (const { topic, qs } of TOPICS) {
    for (const q of qs) {
      try { for (const it of parseRss(await fetchText(gnewsUrl(q))).slice(0, PER_QUERY)) push(topic, it, "Google News"); }
      catch (e) { /* skip */ }
    }
  }
  // 来源 2：媒体 RSS（关键词筛选归类）
  for (const f of FEEDS) {
    try {
      for (const it of parseRss(await fetchText(f.url)).slice(0, PER_FEED)) {
        const topic = classify((it.title || "") + " " + (it.desc || ""));
        if (topic) push(topic, { ...it, src: f.src }, f.src);
      }
    } catch (e) { /* skip */ }
  }

  fresh.sort((a, b) => b.date.localeCompare(a.date));
  const merged = [...fresh, ...existing.items].slice(0, MAX_ITEMS);
  const out = { updated: ymd(now), note: "情报由 GitHub Actions 每日自动抓取（Google News + 多家国内外媒体 RSS）。", items: merged };
  writeFileSync("intel-data.json", JSON.stringify(out, null, 2));
  writeFileSync("intel-data.js", "/* 由 GitHub Actions 每日自动生成，请勿手改 */\nwindow.INTEL = " + JSON.stringify(out, null, 2) + ";\n");
  console.log(`本次新增 ${fresh.length} 条，合计 ${merged.length} 条，updated=${out.updated}`);
}
main();
