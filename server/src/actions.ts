// Actions for the OzBargain monitor.
//
// Data source: the official OzBargain front-page RSS feed
// (https://www.ozbargain.com.au/feed), fetched server-side by
// refreshDeals (manual) and scheduledRefresh (scheduled, gated by the
// user-chosen refresh interval in settings). getBoard only reads cached
// rows from ctx.db, so opening the page costs the user no extra
// traffic. Deal thumbnails are copied into local blob storage
// (server/src/blobs.ts, files under BLOB_DIR) at refresh time; the
// client never hot-links them.

import { defineAction, z, type ActionsModule, type Ctx } from "./sdk";
import { and, asc, desc, eq, lt } from "drizzle-orm";
import * as schema from "./schema";

const FEED_URL = "https://www.ozbargain.com.au/feed";
const DAY_MS = 24 * 60 * 60 * 1000;

// User-selectable auto-refresh intervals (hours). 0 = paused.
// The scheduler wakes scheduledRefresh every 3 hours; it only fetches
// when the chosen interval has elapsed, so options are multiples of 3.
const REFRESH_HOUR_OPTIONS = [0, 3, 6, 12, 24] as const;
type RefreshHours = (typeof REFRESH_HOUR_OPTIONS)[number];

function parseRefreshHours(raw: string | null): RefreshHours {
  const n = raw ? parseInt(raw, 10) : NaN;
  return (REFRESH_HOUR_OPTIONS as readonly number[]).includes(n) ? (n as RefreshHours) : 3;
}

// ---------------------------------------------------------------------------
// Feed parsing helpers
// ---------------------------------------------------------------------------

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function stripCdata(s: string): string {
  const t = s.trim();
  if (t.startsWith("<![CDATA[") && t.endsWith("]]>")) return t.slice(9, -3);
  return t;
}

function tagText(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m?.[1] != null ? decodeEntities(stripCdata(m[1])).trim() : null;
}

function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

interface FeedItem {
  nodeId: number;
  title: string;
  url: string;
  gotoUrl: string | null;
  merchantUrl: string | null;
  imageUrl: string | null;
  category: string;
  tags: string[];
  description: string;
  votesPos: number;
  votesNeg: number;
  comments: number;
  clicks: number;
  pubAt: Date;
  expiryAt: Date | null;
  author: string;
}

function parseFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  for (const block of blocks) {
    const link = tagText(block, "link");
    const title = tagText(block, "title");
    if (!link || !title) continue;
    const nodeMatch = link.match(/\/node\/(\d+)/);
    if (!nodeMatch?.[1]) continue;
    const nodeId = parseInt(nodeMatch[1], 10);

    const metaMatch = block.match(/<ozb:meta\s+([^>]*?)\/>/);
    const attrs: Record<string, string> = {};
    if (metaMatch?.[1]) {
      for (const am of metaMatch[1].matchAll(/([\w-]+)="([^"]*)"/g)) {
        if (am[1] && am[2] != null) attrs[am[1]] = decodeEntities(am[2]);
      }
    }

    const categories: string[] = [];
    for (const cm of block.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/g)) {
      if (cm[1]) categories.push(decodeEntities(stripCdata(cm[1])).trim());
    }
    const category = categories[0] ?? "Other";
    // Tags: remaining categories, minus pure event tags duplicated in title.
    const tags = categories.slice(1, 5);

    const pubRaw = tagText(block, "pubDate");
    const pubAt = pubRaw ? new Date(Date.parse(pubRaw)) : new Date();
    const expiryRaw = attrs["expiry"];
    const expiryAt = expiryRaw ? new Date(Date.parse(expiryRaw)) : null;

    const descRaw = tagText(block, "description") ?? "";
    items.push({
      nodeId,
      title,
      url: link,
      gotoUrl: attrs["link"] ?? null,
      merchantUrl: attrs["url"] ?? null,
      imageUrl: attrs["image"] ?? null,
      category,
      tags,
      description: stripHtml(descRaw).slice(0, 400),
      votesPos: parseInt(attrs["votes-pos"] ?? "0", 10) || 0,
      votesNeg: parseInt(attrs["votes-neg"] ?? "0", 10) || 0,
      comments: parseInt(attrs["comment-count"] ?? "0", 10) || 0,
      clicks: parseInt(attrs["click-count"] ?? "0", 10) || 0,
      pubAt: Number.isNaN(pubAt.getTime()) ? new Date() : pubAt,
      expiryAt: expiryAt && !Number.isNaN(expiryAt.getTime()) ? expiryAt : null,
      author: tagText(block, "dc:creator") ?? "",
    });
  }
  return items;
}

function heatScore(votes: number, comments: number, clicks: number): number {
  const raw =
    18 * Math.log10(1 + votes) +
    14 * Math.log10(1 + comments) +
    10 * Math.log10(1 + clicks);
  return Math.max(0, Math.min(99, Math.round(0.75 * raw)));
}

// ---------------------------------------------------------------------------
// Meta helpers
// ---------------------------------------------------------------------------

async function getMeta(ctx: Ctx, key: string): Promise<string | null> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.meta).where(eq(schema.meta.key, key)).limit(1);
  return rows[0]?.value ?? null;
}

async function setMeta(ctx: Ctx, key: string, value: string): Promise<void> {
  const db = ctx.db<typeof schema>();
  await db
    .insert(schema.meta)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.meta.key, set: { value } });
}

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const trendPoint = z.object({
  at: z.string(),
  votes: z.number(),
  comments: z.number(),
  clicks: z.number(),
  heat: z.number(),
});

const dealOut = z.object({
  nodeId: z.number(),
  title: z.string(),
  url: z.string(),
  gotoUrl: z.string().nullable(),
  category: z.string(),
  tags: z.array(z.string()),
  description: z.string(),
  votesPos: z.number(),
  votesNeg: z.number(),
  comments: z.number(),
  clicks: z.number(),
  pubAt: z.string(),
  expiryAt: z.string().nullable(),
  author: z.string(),
  heatScore: z.number(),
  votesPerHour: z.number(),
  commentsPerHour: z.number(),
  isFavorite: z.boolean(),
  isHidden: z.boolean(),
  imageUrl: z.string().nullable(),
  trend: z.array(trendPoint),
});

const boardResponse = z.object({
  deals: z.array(dealOut),
  lastFetchAt: z.string().nullable(),
  lastFetchOk: z.boolean().nullable(),
  lastFetchMessage: z.string(),
  lastCheckAt: z.string().nullable(),
  settings: z.object({
    minHeat: z.number(),
    keywords: z.string(),
    onlyKeyword: z.boolean(),
    refreshHours: z.number(),
  }),
});

const refreshResponse = z.object({
  ok: z.boolean(),
  count: z.number(),
  newCount: z.number(),
  fetchedAt: z.string(),
  message: z.string(),
});

const scheduledRefreshResponse = refreshResponse.extend({
  skipped: z.boolean(),
});

const okResponse = z.object({ ok: z.literal(true) });

// ---------------------------------------------------------------------------
// Refresh implementation, shared by the manual refreshDeals action and
// the scheduled scheduledRefresh action.
// ---------------------------------------------------------------------------

async function doRefresh(ctx: Ctx): Promise<z.infer<typeof refreshResponse>> {
  const db = ctx.db<typeof schema>();
  const fetchedAt = new Date();
  try {
    const res = await fetch(FEED_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; OzBargainMonitor/1.0)",
        Accept: "application/rss+xml, application/xml",
      },
    });
    if (!res.ok) throw new Error(`OzBargain feed HTTP ${res.status}`);
    const xml = await res.text();
    const items = parseFeed(xml);
    if (items.length === 0) throw new Error("OzBargain feed returned no deals");

    let newCount = 0;
    for (const item of items) {
      const existing = await db
        .select()
        .from(schema.deals)
        .where(eq(schema.deals.nodeId, item.nodeId))
        .limit(1);
      const prev = existing[0];
      if (!prev) newCount += 1;

      const ageHours = Math.max((fetchedAt.getTime() - item.pubAt.getTime()) / 3_600_000, 0.5);
      const heat = heatScore(item.votesPos, item.comments, item.clicks);
      const vph = item.votesPos / ageHours;
      const cph = item.comments / ageHours;

      // Copy the thumbnail into owned blob storage when new or changed.
      let imageBlobKey: string | null = prev?.imageBlobKey ?? null;
      let imageSourceUrl: string | null = prev?.imageSourceUrl ?? null;
      if (item.imageUrl && item.imageUrl !== prev?.imageSourceUrl) {
        try {
          const imgRes = await fetch(item.imageUrl, {
            headers: { "User-Agent": "Mozilla/5.0 (compatible; OzBargainMonitor/1.0)" },
          });
          if (imgRes.ok) {
            const ct = imgRes.headers.get("content-type") ?? "";
            if (ct.startsWith("image/")) {
              const bytes = new Uint8Array(await imgRes.arrayBuffer());
              const key = `deal-${item.nodeId}.jpg`;
              await ctx.blobs.put(key, bytes, { contentType: ct.split(";")[0] ?? "image/jpeg" });
              imageBlobKey = key;
              imageSourceUrl = item.imageUrl;
            }
          }
        } catch {
          // Keep the previous image (or none) on failure.
        }
      }

      const values = {
        nodeId: item.nodeId,
        title: item.title,
        url: item.url,
        gotoUrl: item.gotoUrl,
        merchantUrl: item.merchantUrl,
        imageBlobKey,
        imageSourceUrl,
        category: item.category,
        tags: JSON.stringify(item.tags),
        description: item.description,
        votesPos: item.votesPos,
        votesNeg: item.votesNeg,
        comments: item.comments,
        clicks: item.clicks,
        pubAt: item.pubAt,
        expiryAt: item.expiryAt,
        author: item.author,
        heatScore: heat,
        votesPerHour: vph,
        commentsPerHour: cph,
        firstSeenAt: prev?.firstSeenAt ?? fetchedAt,
        lastSeenAt: fetchedAt,
        isFavorite: prev?.isFavorite ?? 0,
        isHidden: prev?.isHidden ?? 0,
      };
      if (prev) {
        await db.update(schema.deals).set(values).where(eq(schema.deals.nodeId, item.nodeId));
      } else {
        await db.insert(schema.deals).values(values);
      }
      await db.insert(schema.snapshots).values({
        nodeId: item.nodeId,
        capturedAt: fetchedAt,
        votes: item.votesPos,
        comments: item.comments,
        clicks: item.clicks,
        heat,
      });
    }

    // Prune: non-favorite deals not seen for 7+ days, and old snapshots.
    await db
      .delete(schema.deals)
      .where(
        and(
          lt(schema.deals.lastSeenAt, new Date(fetchedAt.getTime() - 7 * DAY_MS)),
          eq(schema.deals.isFavorite, 0),
        ),
      );
    await db
      .delete(schema.snapshots)
      .where(lt(schema.snapshots.capturedAt, new Date(fetchedAt.getTime() - 14 * DAY_MS)));

    const message = `成功获取 ${items.length} 条，新出现 ${newCount} 条`;
    await setMeta(ctx, "fetch.at", fetchedAt.toISOString());
    await setMeta(ctx, "fetch.ok", "1");
    await setMeta(ctx, "fetch.okAt", fetchedAt.toISOString());
    await setMeta(ctx, "fetch.message", message);
    ctx.invalidateQueries();
    return { ok: true, count: items.length, newCount, fetchedAt: fetchedAt.toISOString(), message };
  } catch (e) {
    const message = e instanceof Error ? e.message : "刷新失败";
    await setMeta(ctx, "fetch.at", fetchedAt.toISOString());
    await setMeta(ctx, "fetch.ok", "0");
    await setMeta(ctx, "fetch.message", message);
    ctx.invalidateQueries();
    return { ok: false, count: 0, newCount: 0, fetchedAt: fetchedAt.toISOString(), message };
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const Actions = {
  getBoard: defineAction({
    description: "Returns the cached monitored OzBargain deals, fetch status, and user settings.",
    request: z.object({}),
    response: boardResponse,
    async handler(ctx): Promise<z.infer<typeof boardResponse>> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.deals)
        .orderBy(desc(schema.deals.heatScore))
        .limit(200);

      const cutoff = new Date(Date.now() - 14 * DAY_MS);
      const snaps = await db
        .select()
        .from(schema.snapshots)
        .orderBy(asc(schema.snapshots.capturedAt))
        .limit(4000);
      const trendByNode = new Map<number, z.infer<typeof trendPoint>[]>();
      for (const s of snaps) {
        if (s.capturedAt < cutoff) continue;
        const list = trendByNode.get(s.nodeId) ?? [];
        list.push({
          at: s.capturedAt.toISOString(),
          votes: s.votes,
          comments: s.comments,
          clicks: s.clicks,
          heat: s.heat,
        });
        trendByNode.set(s.nodeId, list);
      }

      const deals: z.infer<typeof dealOut>[] = [];
      for (const r of rows) {
        let imageUrl: string | null = null;
        if (r.imageBlobKey) {
          try {
            imageUrl = await ctx.blobs.getUrl(r.imageBlobKey);
          } catch {
            imageUrl = null;
          }
        }
        let tags: string[] = [];
        try {
          const parsed: unknown = JSON.parse(r.tags);
          if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === "string");
        } catch {
          tags = [];
        }
        const trend = (trendByNode.get(r.nodeId) ?? []).slice(-20);
        deals.push({
          nodeId: r.nodeId,
          title: r.title,
          url: r.url,
          gotoUrl: r.gotoUrl,
          category: r.category,
          tags,
          description: r.description,
          votesPos: r.votesPos,
          votesNeg: r.votesNeg,
          comments: r.comments,
          clicks: r.clicks,
          pubAt: r.pubAt.toISOString(),
          expiryAt: r.expiryAt ? r.expiryAt.toISOString() : null,
          author: r.author,
          heatScore: r.heatScore,
          votesPerHour: Math.round(r.votesPerHour * 10) / 10,
          commentsPerHour: Math.round(r.commentsPerHour * 10) / 10,
          isFavorite: r.isFavorite === 1,
          isHidden: r.isHidden === 1,
          imageUrl,
          trend,
        });
      }

      const minHeatRaw = await getMeta(ctx, "settings.minHeat");
      const keywords = (await getMeta(ctx, "settings.keywords")) ?? "";
      const onlyKeywordRaw = await getMeta(ctx, "settings.onlyKeyword");
      const lastFetchOkRaw = await getMeta(ctx, "fetch.ok");

      return {
        deals,
        lastFetchAt: await getMeta(ctx, "fetch.at"),
        lastFetchOk: lastFetchOkRaw == null ? null : lastFetchOkRaw === "1",
        lastFetchMessage: (await getMeta(ctx, "fetch.message")) ?? "",
        lastCheckAt: await getMeta(ctx, "check.at"),
        settings: {
          minHeat: minHeatRaw ? parseInt(minHeatRaw, 10) || 0 : 0,
          keywords,
          onlyKeyword: onlyKeywordRaw === "1",
          refreshHours: parseRefreshHours(await getMeta(ctx, "settings.refreshHours")),
        },
      };
    },
  }),

  refreshDeals: defineAction({
    description: "Fetches the OzBargain front-page feed now, upserts deals and snapshots, and downloads new thumbnails.",
    request: z.object({}),
    response: refreshResponse,
    async handler(ctx): Promise<z.infer<typeof refreshResponse>> {
      return doRefresh(ctx);
    },
  }),

  scheduledRefresh: defineAction({
    description:
      "Scheduled auto-refresh: records every check in meta, fetches the feed when the user-chosen interval has elapsed since the last successful AUTOMATIC fetch (manual and page-open refreshes never push the automatic schedule out; 30-minute retry after a failure); skipped when paused or not yet due.",
    request: z.object({}),
    response: scheduledRefreshResponse,
    async handler(ctx): Promise<z.infer<typeof scheduledRefreshResponse>> {
      const interval = parseRefreshHours(await getMeta(ctx, "settings.refreshHours"));
      const now = new Date();
      // Record every scheduled wake, fetched or skipped, so the page can
      // show when the monitor last checked — a silent skip is exactly how
      // the board previously went stale without any visible trace.
      const recordCheck = async (result: string): Promise<void> => {
        await setMeta(ctx, "check.at", now.toISOString());
        await setMeta(ctx, "check.result", result);
      };
      const skipped = async (result: string, message: string): Promise<z.infer<typeof scheduledRefreshResponse>> => {
        await recordCheck(result);
        return { ok: true, count: 0, newCount: 0, fetchedAt: now.toISOString(), message, skipped: true };
      };
      if (interval === 0) {
        return skipped("paused", "自动刷新已暂停，跳过本次刷新");
      }
      const lastAttemptRaw = await getMeta(ctx, "fetch.at");
      const lastOk = (await getMeta(ctx, "fetch.ok")) === "1";
      const lastAttemptMs = lastAttemptRaw ? Date.parse(lastAttemptRaw) : NaN;
      if (!lastOk && !Number.isNaN(lastAttemptMs) && now.getTime() - lastAttemptMs < 30 * 60_000) {
        return skipped("retry-wait", "上次刷新失败，30 分钟后自动重试");
      }
      // The automatic cadence is measured from the last successful
      // AUTOMATIC fetch (fetch.schedOkAt), never from fetch.okAt. Manual
      // refreshes and the page-open auto-refresh also write fetch.okAt, so
      // gating on it let every hand refresh push the next automatic fetch
      // a full interval later — with a 6h setting and 3h wakes the
      // scheduler effectively never fetched and the user had to refresh
      // by hand. Manual fetches are now purely extra: they never delay
      // the automatic schedule.
      const lastSchedRaw = await getMeta(ctx, "fetch.schedOkAt");
      const lastSchedMs = lastSchedRaw ? Date.parse(lastSchedRaw) : NaN;
      if (!Number.isNaN(lastSchedMs)) {
        // 5-minute tolerance so a scheduled wake firing slightly early still counts as due.
        const dueMs = interval * 3_600_000 - 5 * 60_000;
        if (now.getTime() - lastSchedMs < dueMs) {
          return skipped("not-due", `距上次自动刷新未满 ${interval} 小时，跳过本次刷新`);
        }
      }
      const r = await doRefresh(ctx);
      if (r.ok) {
        await setMeta(ctx, "fetch.schedOkAt", now.toISOString());
      }
      await recordCheck(r.ok ? "fetched" : "failed");
      return { ...r, skipped: false };
    },
  }),

  toggleFavorite: defineAction({
    description: "Marks or unmarks one monitored deal as a favorite.",
    request: z.object({ nodeId: z.number().int(), favorite: z.boolean() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.deals)
        .set({ isFavorite: args.favorite ? 1 : 0 })
        .where(eq(schema.deals.nodeId, args.nodeId));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  setHidden: defineAction({
    description: "Hides or unhides one monitored deal.",
    request: z.object({ nodeId: z.number().int(), hidden: z.boolean() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.deals)
        .set({ isHidden: args.hidden ? 1 : 0 })
        .where(eq(schema.deals.nodeId, args.nodeId));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  saveSettings: defineAction({
    description: "Saves monitor settings: minimum heat score, watch keywords, keyword-only filter, and auto-refresh interval hours.",
    request: z.object({
      minHeat: z.number().int().min(0).max(99),
      keywords: z.string().max(200),
      onlyKeyword: z.boolean(),
      refreshHours: z.union([z.literal(0), z.literal(3), z.literal(6), z.literal(12), z.literal(24)]),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      await setMeta(ctx, "settings.minHeat", String(args.minHeat));
      await setMeta(ctx, "settings.keywords", args.keywords.trim());
      await setMeta(ctx, "settings.onlyKeyword", args.onlyKeyword ? "1" : "0");
      await setMeta(ctx, "settings.refreshHours", String(args.refreshHours));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),
} satisfies ActionsModule;
