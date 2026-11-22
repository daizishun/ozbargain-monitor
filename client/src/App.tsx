// OzBargain 监测 — front-page deal monitor matching the user's reference
// screenshot: cream background, orange accents, heat-tier pills, category
// row, and deal cards with 热度分 / 票数 / 评论 / 点击 / 每小时增速.

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "./safe-area";
import type { Actions } from "../../server/src/actions";
import { api, type ApiResponse } from "./api";

// 原来由 `@hatch/space-sdk/fields` 宏从服务端 zod schema 生成的表单
// 属性，这里按 saveSettings 请求 schema 的约束手写成常量
// （minHeat 0–99 整数、keywords 最长 200 字符），与服务端校验一致。
// 用宽松的 Record 类型，避免字面量 key 与 input 自带的 type 等
// 属性在展开时冲突（原来宏返回的也是宽松类型）。
const FIELDS: { saveSettings: Record<string, Record<string, string | number | boolean>> } = {
  saveSettings: {
    minHeat: { name: "minHeat", type: "number", step: 1, min: 0, max: 99, required: true },
    keywords: { name: "keywords", maxLength: 200 },
    refreshHours: { name: "refreshHours" },
  },
};

type Board = ApiResponse<typeof Actions, "getBoard">;
type Deal = Board["deals"][number];

type Tier = "all" | "fire" | "burst" | "hot" | "fav" | "hidden";
type SortKey = "heat" | "newest" | "votes" | "comments" | "clicks";

const TIER_DEFS: { key: Tier; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "fire", label: "🔥🔥 爆火" },
  { key: "burst", label: "⚡ 正在爆发" },
  { key: "hot", label: "🔥 热门" },
  { key: "fav", label: "☆ 收藏" },
  { key: "hidden", label: "已隐藏" },
];

const REFRESH_OPTIONS: { hours: number; label: string }[] = [
  { hours: 3, label: "每 3 小时" },
  { hours: 6, label: "每 6 小时" },
  { hours: 12, label: "每 12 小时" },
  { hours: 24, label: "每 24 小时" },
  { hours: 0, label: "暂停自动刷新" },
];

function refreshLabel(hours: number): string {
  return hours === 0 ? "自动刷新已暂停" : `每 ${hours} 小时自动刷新`;
}

function isFire(d: Deal) {
  return d.heatScore >= 75;
}
function isBurst(d: Deal) {
  return d.votesPerHour >= 5;
}
function isHot(d: Deal) {
  return d.heatScore >= 55;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins}分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}小时前`;
  return `${Math.floor(hours / 24)}天前`;
}

function expiryLabel(iso: string | null): string | null {
  if (!iso) return null;
  const diff = new Date(iso).getTime() - Date.now();
  if (diff < 0) return "已过期";
  const days = Math.ceil(diff / 86400000);
  if (days <= 1) return "今天到期";
  return `${days}天后过期`;
}

function parseKeywords(raw: string): string[] {
  return raw
    .split(/[,，、\s]+/)
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
}

function matchesKeywords(d: Deal, kws: string[]): boolean {
  if (kws.length === 0) return false;
  const hay = `${d.title} ${d.category} ${d.tags.join(" ")} ${d.description}`.toLowerCase();
  return kws.some((k) => hay.includes(k));
}

function fmtNum(n: number): string {
  return n.toLocaleString("en-AU");
}

function extractPrice(title: string): string | null {
  const m = title.match(/\$\s?\d[\d,]*(?:\.\d{1,2})?/);
  if (m) return m[0].replace(/\s+/g, "");
  if (/\bfree\b/i.test(title)) return "免费";
  return null;
}

function Sparkline({ deal }: { deal: Deal }) {
  const pts = deal.trend;
  if (pts.length < 2) {
    return (
      <p className="text-sm text-[var(--dim)]">
        已记录 {pts.length} 次快照，下次刷新后就能看到票数走势。
      </p>
    );
  }
  const values = pts.map((p) => p.votes);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 1);
  const w = 260;
  const h = 44;
  const coords = values
    .map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 4 - ((v - min) / range) * (h - 8)).toFixed(1)}`)
    .join(" ");
  const first = pts[0];
  const last = pts[pts.length - 1];
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full max-w-[260px]" role="img" aria-label="票数走势图">
        <polyline points={coords} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinejoin="round" />
      </svg>
      {first && last && (
        <p className="mt-1 text-sm text-[var(--dim)]">
          {timeAgo(first.at)} {first.votes} 票 → 现在 {last.votes} 票 · 共 {pts.length} 次快照
        </p>
      )}
    </div>
  );
}

function DealCard({
  deal,
  keywordHit,
  expanded,
  onToggleExpand,
  onToggleFavorite,
  onSetHidden,
}: {
  deal: Deal;
  keywordHit: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleFavorite: () => void;
  onSetHidden: (hidden: boolean) => void;
}) {
  const net = deal.votesPos - deal.votesNeg;
  const expiry = expiryLabel(deal.expiryAt);
  const price = extractPrice(deal.title);
  const initial = (deal.category.trim()[0] ?? "O").toUpperCase();
  return (
    <article className="rounded-[20px] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[0_1px_3px_rgba(120,72,0,0.06)]">
      <div className="flex gap-3">
        {deal.imageUrl ? (
          <img
            src={deal.imageUrl}
            alt={deal.title}
            className="h-[88px] w-[88px] shrink-0 rounded-xl object-cover"
            loading="lazy"
          />
        ) : (
          <div
            aria-hidden
            className="flex h-[88px] w-[88px] shrink-0 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-3xl font-extrabold text-[var(--accent)]"
          >
            {initial}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="line-clamp-2 text-[17px] font-bold leading-snug text-[var(--text)]">{deal.title}</h3>
            <div className="shrink-0 text-center">
              <div className="text-[32px] font-extrabold leading-none text-[var(--accent)]">{deal.heatScore}</div>
              <div className="mt-1 text-xs text-[var(--dim)]">热度分</div>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {isFire(deal) && (
          <span className="rounded-full bg-[var(--accent-soft)] px-2.5 py-1 text-xs font-semibold text-[var(--accent-ink)]">🔥🔥 爆火</span>
        )}
        {!isFire(deal) && isHot(deal) && (
          <span className="rounded-full bg-[var(--accent-soft)] px-2.5 py-1 text-xs font-semibold text-[var(--accent-ink)]">🔥 热门</span>
        )}
        {isBurst(deal) && (
          <span className="rounded-full bg-[var(--accent-soft)] px-2.5 py-1 text-xs font-semibold text-[var(--accent-ink)]">⚡ 正在爆发</span>
        )}
        <span className="rounded-full bg-[var(--accent-soft)] px-2.5 py-1 text-xs font-semibold text-[var(--accent-ink)]">首页推荐</span>
        <span className="rounded-full bg-[var(--accent-soft)] px-2.5 py-1 text-xs text-[var(--accent-ink)]">{deal.category}</span>
        {keywordHit && (
          <span className="rounded-full bg-[var(--pill-dark)] px-2.5 py-1 text-xs font-semibold text-[var(--bg)]">关注命中</span>
        )}
        {expiry && <span className="rounded-full bg-[var(--bg)] px-2.5 py-1 text-xs text-[var(--dim)]">{expiry}</span>}
      </div>

      <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[15px] text-[var(--text)]">
        {price && (
          <span>
            <b className="font-extrabold text-[var(--accent)]">{price}</b>
          </span>
        )}
        <span>
          <b className="font-extrabold">{net >= 0 ? `+${net}` : net}</b> <span className="text-[var(--dim)]">票</span>
        </span>
        <span>
          <b className="font-extrabold">{fmtNum(deal.comments)}</b> <span className="text-[var(--dim)]">评论</span>
        </span>
        <span>
          <b className="font-extrabold">{fmtNum(deal.clicks)}</b> <span className="text-[var(--dim)]">点击</span>
        </span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-sm font-semibold text-[var(--accent)]">
          ↗ {deal.votesPerHour}/h 票 · {deal.commentsPerHour}/h 评
        </span>
        <span className="text-sm text-[var(--dim)]">
          {timeAgo(deal.pubAt)}
          {deal.author ? ` · @${deal.author}` : ""}
        </span>
      </div>

      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--accent-soft)]" aria-hidden>
        <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${deal.heatScore}%` }} />
      </div>

      {expanded && (
        <div className="mt-3 rounded-xl bg-[var(--bg)] p-3">
          {deal.description && <p className="text-sm leading-relaxed text-[var(--text)]">{deal.description}</p>}
          <div className="mt-3">
            <p className="mb-1 text-sm font-bold text-[var(--text)]">票数走势</p>
            <Sparkline deal={deal} />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <a
              href={deal.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-8 items-center rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-sm font-semibold text-[var(--text)]"
            >
              OzBargain 原帖
            </a>
            {deal.gotoUrl && (
              <a
                href={deal.gotoUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-8 items-center rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-sm font-semibold text-[var(--text)]"
              >
                直达优惠 →
              </a>
            )}
          </div>
        </div>
      )}

      <div className="mt-3 flex items-center justify-between gap-1">
        <button
          type="button"
          onClick={onToggleFavorite}
          aria-label={deal.isFavorite ? `取消收藏 ${deal.title}` : `收藏 ${deal.title}`}
          className={`shrink-0 whitespace-nowrap px-0.5 text-sm ${deal.isFavorite ? "font-bold text-[var(--accent)]" : "text-[var(--dim)]"}`}
        >
          {deal.isFavorite ? "★ 已收藏" : "☆ 收藏"}
        </button>
        <button
          type="button"
          onClick={onToggleExpand}
          aria-expanded={expanded}
          className="shrink-0 whitespace-nowrap px-0.5 text-sm text-[var(--dim)]"
        >
          走势/详情 {expanded ? "▴" : "▾"}
        </button>
        <a
          href={deal.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`去看看 ${deal.title}`}
          className="inline-flex min-h-9 shrink-0 items-center whitespace-nowrap rounded-full bg-[var(--accent)] px-3.5 py-1.5 text-sm font-bold text-white"
        >
          去看看 →
        </a>
        {deal.isHidden ? (
          <button type="button" onClick={() => onSetHidden(false)} className="shrink-0 whitespace-nowrap px-0.5 text-sm text-[var(--dim)]">
            恢复
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onSetHidden(true)}
            aria-label={`隐藏 ${deal.title}`}
            className="shrink-0 whitespace-nowrap px-0.5 text-sm text-[var(--dim)]"
          >
            ✕ 隐藏
          </button>
        )}
      </div>
    </article>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const board = useQuery({ queryKey: ["board"], queryFn: () => api.getBoard({}) });

  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("newest");
  const [tier, setTier] = useState<Tier>("all");
  const [category, setCategory] = useState<string>("全部分类");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [showLogic, setShowLogic] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Settings form (in-flight input only; saved values come from the server).
  const [formMinHeat, setFormMinHeat] = useState(0);
  const [formKeywords, setFormKeywords] = useState("");
  const [formOnlyKeyword, setFormOnlyKeyword] = useState(false);
  const [formRefreshHours, setFormRefreshHours] = useState(3);

  const refresh = useMutation({
    mutationFn: async () => await api.refreshDeals({}),
    onSuccess: (r) => {
      setNotice(r.ok ? `刷新完成：${r.message}` : `刷新失败：${r.message}，先显示上次的数据`);
      void queryClient.invalidateQueries({ queryKey: ["board"] });
    },
    onError: (e) => setNotice(`刷新失败：${e instanceof Error ? e.message : "请稍后再试"}`),
  });

  // Keep the page in sync with the monitor. New deals can land in the
  // feed at any time (the chat notifications announce them as soon as a
  // check finds them), while this page reads the artifact's cached rows —
  // so the page must re-check freshness itself instead of trusting the
  // background interval. The page-driven sync threshold is 10 minutes,
  // far shorter than the settings interval (which only governs the
  // server-side schedule): opening the page, returning to it, regaining
  // connectivity, or leaving it open all refetch the board, and whenever
  // the last fetch is over 10 minutes old they fetch the current front
  // page too — deals announced in chat are then already here, with no
  // manual 立即刷新. Paused (0) stays manual-only, except the very first
  // load of a never-fetched board.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const boardRef = useRef(board);
  boardRef.current = board;
  const lastSyncAttempt = useRef(0);

  const syncIfStale = (data: Board | undefined) => {
    if (!data || refreshRef.current.isPending) return;
    const now = Date.now();
    if (now - lastSyncAttempt.current < 60_000) return;
    let due = false;
    if (!data.lastFetchAt) {
      due = true;
    } else if (data.settings.refreshHours > 0) {
      due = now - new Date(data.lastFetchAt).getTime() >= 10 * 60_000;
    }
    if (due) {
      lastSyncAttempt.current = now;
      refreshRef.current.mutate();
    }
  };

  // Sync on first load and whenever a board refetch lands new data.
  useEffect(() => {
    syncIfStale(board.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.data]);

  // Sync when returning to the page or when connectivity comes back, and
  // re-check every 3 minutes while the page stays open, so a background
  // refresh (or a chat-announced batch of deals) shows up on its own.
  useEffect(() => {
    const wake = () => {
      if (document.visibilityState === "hidden") return;
      void boardRef.current.refetch().then((r) => syncIfStale(r.data));
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") wake();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    const timer = window.setInterval(wake, 3 * 60_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fav = useMutation({
    mutationFn: async (v: { nodeId: number; favorite: boolean }) => await api.toggleFavorite(v),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["board"] }),
    onError: () => setNotice("收藏操作失败，请稍后再试"),
  });
  const hide = useMutation({
    mutationFn: async (v: { nodeId: number; hidden: boolean }) => await api.setHidden(v),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["board"] }),
    onError: () => setNotice("隐藏操作失败，请稍后再试"),
  });
  const saveSettings = useMutation({
    mutationFn: async () =>
      await api.saveSettings({
        minHeat: formMinHeat,
        keywords: formKeywords,
        onlyKeyword: formOnlyKeyword,
        refreshHours: formRefreshHours as 0 | 3 | 6 | 12 | 24,
      }),
    onSuccess: () => {
      setNotice("设置已保存");
      setShowSettings(false);
      void queryClient.invalidateQueries({ queryKey: ["board"] });
    },
    onError: () => setNotice("设置保存失败，请稍后再试"),
  });

  const data = board.data;
  const settings = data?.settings ?? { minHeat: 0, keywords: "", onlyKeyword: false, refreshHours: 3 };
  const kws = useMemo(() => parseKeywords(settings.keywords), [settings.keywords]);

  const visible = useMemo(() => {
    if (!data) return [];
    let list = data.deals;
    if (tier === "hidden") {
      list = list.filter((d) => d.isHidden);
    } else {
      list = list.filter((d) => !d.isHidden);
      if (tier === "fire") list = list.filter(isFire);
      if (tier === "burst") list = list.filter(isBurst);
      if (tier === "hot") list = list.filter(isHot);
      if (tier === "fav") list = list.filter((d) => d.isFavorite);
      list = list.filter((d) => d.heatScore >= settings.minHeat);
      if (settings.onlyKeyword && kws.length > 0) list = list.filter((d) => matchesKeywords(d, kws));
    }
    if (category !== "全部分类") list = list.filter((d) => d.category === category);
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((d) =>
        `${d.title} ${d.category} ${d.tags.join(" ")} ${d.description}`.toLowerCase().includes(q),
      );
    }
    const sorted = [...list];
    switch (sort) {
      case "heat":
        sorted.sort((a, b) => b.heatScore - a.heatScore);
        break;
      case "newest":
        sorted.sort((a, b) => +new Date(b.pubAt) - +new Date(a.pubAt));
        break;
      case "votes":
        sorted.sort((a, b) => b.votesPos - b.votesNeg - (a.votesPos - a.votesNeg));
        break;
      case "comments":
        sorted.sort((a, b) => b.comments - a.comments);
        break;
      case "clicks":
        sorted.sort((a, b) => b.clicks - a.clicks);
        break;
    }
    return sorted;
  }, [data, tier, category, search, sort, settings.minHeat, settings.onlyKeyword, kws]);

  const counts = useMemo(() => {
    const all = (data?.deals ?? []).filter((d) => !d.isHidden);
    return {
      all: all.length,
      fire: all.filter(isFire).length,
      burst: all.filter(isBurst).length,
      hot: all.filter(isHot).length,
      fav: all.filter((d) => d.isFavorite).length,
      hidden: (data?.deals ?? []).filter((d) => d.isHidden).length,
    } as Record<Tier, number>;
  }, [data]);

  const categories = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of data?.deals ?? []) {
      if (d.isHidden) continue;
      map.set(d.category, (map.get(d.category) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  }, [data]);

  const headingLabel =
    tier === "all" && category === "全部分类"
      ? "全部监控"
      : tier === "hidden"
        ? "已隐藏"
        : tier === "fav"
          ? "收藏"
          : category !== "全部分类"
            ? category
            : (TIER_DEFS.find((t) => t.key === tier)?.label.replace(/^[🔥⚡\s]+/, "") ?? "全部监控");

  const openSettings = () => {
    setFormMinHeat(settings.minHeat);
    setFormKeywords(settings.keywords);
    setFormOnlyKeyword(settings.onlyKeyword);
    setFormRefreshHours(settings.refreshHours);
    setShowSettings((v) => !v);
    setShowLogic(false);
  };

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto w-full max-w-6xl px-4 pb-10 pt-3">
        {/* Header row, per the reference screenshot */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h1 className="truncate text-[22px] font-extrabold leading-tight">OzBargain 监测</h1>
            <p className="mt-0.5 truncate text-[13px] text-[var(--dim)]">
              {data?.lastFetchAt
                ? `更新于 ${timeAgo(data.lastFetchAt)} · ${data.lastFetchOk ? "成功" : "失败"}${data.lastFetchMessage ? ` · ${data.lastFetchMessage}` : ""}${data.lastCheckAt && data.lastCheckAt !== data.lastFetchAt ? ` · 定时检查于 ${timeAgo(data.lastCheckAt)}` : ""}`
                : "还没刷新过，点立即刷新获取最新 deals"}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => {
                setShowLogic((v) => !v);
                setShowSettings(false);
              }}
              aria-expanded={showLogic}
              className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-3.5 py-1.5 text-[15px] font-semibold"
            >
              逻辑
            </button>
            <button
              type="button"
              onClick={openSettings}
              aria-expanded={showSettings}
              className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-3.5 py-1.5 text-[15px] font-semibold"
            >
              设置
            </button>
            <button
              type="button"
              onClick={() => refresh.mutate()}
              disabled={refresh.isPending}
              className="rounded-full bg-[var(--accent)] px-4 py-1.5 text-[15px] font-bold text-white disabled:opacity-60"
            >
              {refresh.isPending ? "刷新中…" : "↻ 立即刷新"}
            </button>
          </div>
        </div>

        {notice && (
          <p role="status" className="mt-3 rounded-xl bg-[var(--accent-soft)] px-3 py-2 text-sm text-[var(--accent-ink)]">
            {notice}
          </p>
        )}

        {showLogic && (
          <section aria-label="监测逻辑说明" className="mt-3 rounded-[20px] border border-[var(--border)] bg-[var(--surface)] p-4 text-sm leading-relaxed">
            <h2 className="text-base font-extrabold">监测逻辑</h2>
            <ul className="mt-2 list-disc space-y-1.5 pl-5">
              <li>数据源：OzBargain 首页推荐 RSS。服务器每 3 小时检查一次，按你在「设置」里选的自动刷新间隔（当前：{settings.refreshHours === 0 ? "已暂停" : `每 ${settings.refreshHours} 小时`}）决定是否抓取；这个间隔只管服务器的后台节奏，按上一次「自动」成功抓取的时间算，你手动点刷新不会把下一次自动刷新往后推。页面这边另有一层同步：打开页面、从别的页面切回来、网络恢复时都会先重新读取最新数据，只要数据已超过 10 分钟没更新就会自动抓一次当前首页，页面开着时每 3 分钟也会检查一次。所以聊天里通知的新 deals，打开页面就能看到，不用再手动点刷新（设置里选了「暂停自动刷新」时除外，那就只靠手动刷新）。每次定时检查（包括跳过的）都会记下来，页头会显示最近一次检查时间；抓取全程在服务器上进行，不走你手机的流量。</li>
              <li>热度分（0–99）：由票数、评论数、点击数加权计算 —— 18×log₁₀(1+票) + 14×log₁₀(1+评论) + 10×log₁₀(1+点击)，再 ×0.75 取整封顶。</li>
              <li>分级：热度 ≥75 是「🔥🔥 爆火」，≥55 是「🔥 热门」；每小时涨票 ≥5 是「⚡ 正在爆发」。</li>
              <li>增速：总票数（或评论数）÷ 发布至今的小时数，就是卡片上的 X/h 票 · Y/h 评。</li>
              <li>每次刷新都会存一份快照，点「走势 / 详情」能看票数变化；7 天没再上首页的 deal 会自动移出监控（收藏的保留）。</li>
            </ul>
            <button type="button" onClick={() => setShowLogic(false)} className="mt-3 font-semibold text-[var(--accent)]">
              关闭
            </button>
          </section>
        )}

        {showSettings && (
          <section aria-label="监测设置" className="mt-3 rounded-[20px] border border-[var(--border)] bg-[var(--surface)] p-4">
            <h2 className="text-base font-extrabold">设置</h2>
            <div className="mt-3 space-y-4">
              <div>
                <label htmlFor="min-heat" className="text-sm font-semibold">
                  最低热度分：{formMinHeat}
                </label>
                <input
                  id="min-heat"
                  type="range"
                  aria-label="最低热度分"
                  {...FIELDS.saveSettings.minHeat}
                  min={0}
                  max={99}
                  value={formMinHeat}
                  onChange={(e) => setFormMinHeat(parseInt(e.target.value, 10) || 0)}
                  className="mt-1 w-full accent-[#e85d04]"
                />
                <p className="text-xs text-[var(--dim)]">低于这个热度分的 deal 不显示（收藏和已隐藏视图不受影响）。</p>
              </div>
              <div>
                <label htmlFor="watch-keywords" className="text-sm font-semibold">
                  关注关键词
                </label>
                <input
                  id="watch-keywords"
                  type="text"
                  aria-label="关注关键词"
                  {...FIELDS.saveSettings.keywords}
                  value={formKeywords}
                  onChange={(e) => setFormKeywords(e.target.value)}
                  placeholder="例如：iPhone、Coles、免费"
                  className="mt-1 w-full rounded-full border border-[var(--border)] bg-[var(--bg)] px-4 py-2 text-[15px] outline-none"
                />
                <p className="text-xs text-[var(--dim)]">用逗号或空格分隔；命中的 deal 会带「关注命中」标记。</p>
              </div>
              <label className="flex min-h-9 items-center gap-2 text-sm font-semibold">
                <input
                  type="checkbox"
                  aria-label="只看命中关注关键词的 deal"
                  checked={formOnlyKeyword}
                  onChange={(e) => setFormOnlyKeyword(e.target.checked)}
                  className="h-5 w-5 accent-[#e85d04]"
                />
                只看命中关注关键词的 deal
              </label>
              <div>
                <label htmlFor="refresh-hours" className="text-sm font-semibold">
                  自动刷新间隔
                </label>
                <select
                  id="refresh-hours"
                  aria-label="自动刷新间隔"
                  {...FIELDS.saveSettings.refreshHours}
                  value={formRefreshHours}
                  onChange={(e) => setFormRefreshHours(parseInt(e.target.value, 10) || 0)}
                  className="mt-1 w-full rounded-full border border-[var(--border)] bg-[var(--bg)] px-4 py-2 text-[15px] font-semibold outline-none"
                >
                  {REFRESH_OPTIONS.map((o) => (
                    <option key={o.hours} value={o.hours}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-[var(--dim)]">
                  这个间隔只管服务器的后台检查：服务器每 3 小时醒一次，到了间隔才真正抓取新 deals，全程不走你手机的流量。打开页面时如果数据已超过 10 分钟没更新，页面会自己同步一次，不受这个间隔影响；选「暂停」后，后台和页面都不自动抓取，只靠手动点「立即刷新」。当前生效：{refreshLabel(settings.refreshHours)}。
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => saveSettings.mutate()}
                  disabled={saveSettings.isPending}
                  className="rounded-full bg-[var(--accent)] px-5 py-2 text-[15px] font-bold text-white disabled:opacity-60"
                >
                  {saveSettings.isPending ? "保存中…" : "保存设置"}
                </button>
                <button type="button" onClick={() => setShowSettings(false)} className="px-3 text-[15px] text-[var(--dim)]">
                  取消
                </button>
              </div>
            </div>
          </section>
        )}

        {/* Search + sort */}
        <div className="mt-4 flex gap-2">
          <input
            type="search"
            aria-label="搜索 deals"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索：iPhone、Coles、免费、商家…"
            className="min-w-0 flex-1 rounded-full border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-[15px] outline-none"
          />
          <select
            aria-label="排序方式"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="shrink-0 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[15px] font-semibold outline-none"
          >
            <option value="heat">热度最高</option>
            <option value="newest">最新发布</option>
            <option value="votes">票数最多</option>
            <option value="comments">评论最多</option>
            <option value="clicks">点击最多</option>
          </select>
        </div>

        {/* Heat-tier pills */}
        <div className="mt-3 flex gap-2 overflow-x-auto pb-1" role="group" aria-label="按热度筛选">
          {TIER_DEFS.map((t) => {
            const active = tier === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTier(t.key)}
                aria-pressed={active}
                className={`shrink-0 whitespace-nowrap rounded-full px-4 py-2 text-[15px] font-semibold ${
                  active
                    ? "bg-[var(--pill-dark)] text-[var(--bg)]"
                    : "border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
                }`}
              >
                {t.label} {counts[t.key]}
              </button>
            );
          })}
        </div>

        {/* Category row */}
        <div className="mt-1 flex gap-2 overflow-x-auto pb-1" role="group" aria-label="按分类筛选">
          {["全部分类", ...categories].map((c) => {
            const active = category === c;
            return (
              <button
                key={c}
                type="button"
                onClick={() => setCategory(c)}
                aria-pressed={active}
                className={`shrink-0 whitespace-nowrap rounded-full px-3.5 py-2 text-[15px] ${
                  active ? "bg-[var(--accent)] font-bold text-white" : "text-[var(--dim)]"
                }`}
              >
                {c === "全部分类" ? c : c}
              </button>
            );
          })}
        </div>

        <h2 className="mt-4 text-[22px] font-extrabold">
          {headingLabel} Deal <span className="text-lg font-normal text-[var(--dim)]">{visible.length} 条</span>
        </h2>

        <div className="mt-3 space-y-4">
          {board.isPending && <p className="py-10 text-center text-[var(--dim)]">正在加载监控列表…</p>}
          {board.error && (
            <div className="py-10 text-center">
              <p className="text-[var(--dim)]">加载失败，请稍后再试。</p>
              <button
                type="button"
                onClick={() => void board.refetch()}
                className="mt-3 rounded-full bg-[var(--accent)] px-5 py-2 font-bold text-white"
              >
                重试
              </button>
            </div>
          )}
          {data && data.deals.length === 0 && !refresh.isPending && (
            <div className="py-10 text-center">
              <p className="text-[var(--dim)]">还没有监控到任何 deal。</p>
              <button
                type="button"
                onClick={() => refresh.mutate()}
                className="mt-3 rounded-full bg-[var(--accent)] px-5 py-2 font-bold text-white"
              >
                ↻ 立即刷新
              </button>
            </div>
          )}
          {data && data.deals.length > 0 && visible.length === 0 && (
            <p className="py-10 text-center text-[var(--dim)]">当前筛选下没有 deal，换个分类或降低最低热度试试。</p>
          )}
          {visible.map((deal) => (
            <DealCard
              key={deal.nodeId}
              deal={deal}
              keywordHit={matchesKeywords(deal, kws)}
              expanded={expandedId === deal.nodeId}
              onToggleExpand={() => setExpandedId(expandedId === deal.nodeId ? null : deal.nodeId)}
              onToggleFavorite={() => fav.mutate({ nodeId: deal.nodeId, favorite: !deal.isFavorite })}
              onSetHidden={(hidden) => hide.mutate({ nodeId: deal.nodeId, hidden })}
            />
          ))}
        </div>

        <p className="mt-6 text-center text-xs text-[var(--dim)]">
          数据来自 OzBargain 首页推荐 · {refreshLabel(settings.refreshHours)} · 价格与库存以商家页面为准
        </p>
      </main>
    </div>
  );
}
