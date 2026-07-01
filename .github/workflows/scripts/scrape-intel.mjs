/* ============================================================
   每日情报抓取 · GitHub Actions 用（Node 20+，零依赖）
   ------------------------------------------------------------
   通过 Google News RSS 抓取「当天/最近」车机体验设计相关资讯，
   分主题整理，合并去重后写入 intel-data.json 和 intel-data.js。
   由 .github/workflows/daily-intel.yml 每天自动运行并提交。
   无需任何 API Key。
   ============================================================ */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

/* 每个主题配若干检索词，中英混合以覆盖国内外厂商 */
const TOPICS = [
  { topic: "芯片算力", qs: ["智能座舱芯片 座舱SoC", "舱驾一体 芯片 算力", "automotive cockpit SoC chip Qualcomm Nvidia"] },
  { topic: "中控仪表", qs: ["车载中控屏 仪表 贯穿屏", "座舱显示 面板 京东方 天马", "automotive cockpit display pillar-to-pillar LG Samsung"] },
  { topic: "HUD", qs: ["AR-HUD 抬头显示", "P-HUD 全景抬头显示", "automotive AR HUD head-up display Valeo Continental"] },
  { topic: "座舱AI", qs: ["智能座舱 大模型 AI Agent", "鸿蒙座舱 语音助手 座舱操作系统", "automotive cockpit AI assistant voice"] },
  { topic: "舱驾一体", qs: ["舱驾一体 中央计算", "座舱域控制器 中央计算平台", "automotive central compute cockpit domain controller"] },
];

const DAYS = 4;        // 只收最近几天的资讯
const PER_QUERY = 8;   // 每个检索词最多取几条
const MAX_ITEMS = 60;  // 数据文件最多保留条数

const isEn = (q) => /[a-z]/i.test(q) && !/[一-鿿]/.test(q);
function gnewsUrl(q) {
  const en = isEn(q);
  const hl = en ? "en-US" : "zh-CN", gl = en ? "US" : "CN", ceid = en ? "US:en" : "CN:zh-Hans";
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:7d")}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
}
function clean(s) {
  return (s || "").replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")   // 先解码实体，再去标签
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ").trim();
}
function parseRss(xml) {
  const out = []; const re = /<item>([\s\S]*?)<\/item>/g; let m;
  while ((m = re.exec(xml))) {
    const b = m[1];
    const pick = (tag) => { const r = new RegExp("<" + tag + "(?:[^>]*)>([\\s\\S]*?)<\\/" + tag + ">").exec(b); return r ? r[1] : ""; };
    out.push({ title: clean(pick("title")), link: clean(pick("link")), pub: pick("pubDate"), desc: clean(pick("description")), src: clean(pick("source")) });
  }
  return out;
}
const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9一-鿿]/g, "");

async function main() {
  const now = Date.now(), cutoff = now - DAYS * 864e5;
  let existing = { updated: "", note: "", items: [] };
  if (existsSync("intel-data.json")) { try { existing = JSON.parse(readFileSync("intel-data.json", "utf8")); } catch (e) {} }
  if (!Array.isArray(existing.items)) existing.items = [];
  const seenT = new Set(existing.items.map((i) => norm(i.title)));
  const seenU = new Set(existing.items.map((i) => i.url));
  const fresh = [];

  for (const { topic, qs } of TOPICS) {
    for (const q of qs) {
      try {
        const r = await fetch(gnewsUrl(q), { headers: { "User-Agent": "Mozilla/5.0" } });
        if (!r.ok) continue;
        const items = parseRss(await r.text()).slice(0, PER_QUERY);
        for (const it of items) {
          if (!it.title || !it.link) continue;
          const t = new Date(it.pub || now).getTime();
          if (isFinite(t) && t < cutoff) continue;
          const key = norm(it.title);
          if (seenT.has(key) || seenU.has(it.link)) continue;
          seenT.add(key); seenU.add(it.link);
          let title = it.title.replace(/\s+-\s+[^-]+$/, "").trim();
          if (title.length > 52) title = title.slice(0, 50) + "…";
          let summary = it.desc && it.desc.length > 12 ? it.desc : it.title;
          summary = summary.replace(/\s+-\s+[^-]+$/, "").trim();
          if (summary.length > 95) summary = summary.slice(0, 93) + "…";
          fresh.push({
            id: "g" + Math.random().toString(36).slice(2, 8),
            date: ymd(isFinite(t) ? t : now), topic, title, summary,
            source: it.src || "Google News", url: it.link,
          });
        }
      } catch (e) { /* 单条失败跳过 */ }
    }
  }

  fresh.sort((a, b) => b.date.localeCompare(a.date));
  const merged = [...fresh, ...existing.items].slice(0, MAX_ITEMS);
  const out = { updated: ymd(now), note: "情报由 GitHub Actions 每日自动抓取（Google News，含国内外厂商）。", items: merged };
  writeFileSync("intel-data.json", JSON.stringify(out, null, 2));
  writeFileSync("intel-data.js", "/* 由 GitHub Actions 每日自动生成，请勿手改 */\nwindow.INTEL = " + JSON.stringify(out, null, 2) + ";\n");
  console.log(`本次新增 ${fresh.length} 条，合计 ${merged.length} 条，updated=${out.updated}`);
}
main();
