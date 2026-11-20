// Drizzle schema for the OzBargain monitor.
//
// deals: one row per OzBargain node ever seen on the front-page feed.
// snapshots: one row per deal per refresh, for the trend (走势) view.
// meta: key/value store for fetch status and user settings.

import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const deals = sqliteTable("deals", {
  nodeId: integer("node_id").primaryKey(),
  title: text("title").notNull(),
  url: text("url").notNull(),
  gotoUrl: text("goto_url"),
  merchantUrl: text("merchant_url"),
  imageBlobKey: text("image_blob_key"),
  imageSourceUrl: text("image_source_url"),
  category: text("category").notNull(),
  tags: text("tags").notNull(), // JSON array of strings
  description: text("description").notNull(),
  votesPos: integer("votes_pos").notNull(),
  votesNeg: integer("votes_neg").notNull(),
  comments: integer("comments").notNull(),
  clicks: integer("clicks").notNull(),
  pubAt: integer("pub_at", { mode: "timestamp_ms" }).notNull(),
  expiryAt: integer("expiry_at", { mode: "timestamp_ms" }),
  author: text("author").notNull(),
  heatScore: integer("heat_score").notNull(),
  votesPerHour: real("votes_per_hour").notNull(),
  commentsPerHour: real("comments_per_hour").notNull(),
  firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull(),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
  isFavorite: integer("is_favorite").notNull().default(0),
  isHidden: integer("is_hidden").notNull().default(0),
});

export const snapshots = sqliteTable("snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  nodeId: integer("node_id").notNull(),
  capturedAt: integer("captured_at", { mode: "timestamp_ms" }).notNull(),
  votes: integer("votes").notNull(),
  comments: integer("comments").notNull(),
  clicks: integer("clicks").notNull(),
  heat: integer("heat").notNull(),
});

export const meta = sqliteTable("meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
