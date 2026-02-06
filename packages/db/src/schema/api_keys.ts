import { sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const apiKeys = sqliteTable("api_keys", {
	id: text("id").primaryKey(),
	agentId: text("agent_id").notNull(),
	keyHash: text("key_hash").notNull(),
	keyPrefix: text("key_prefix").notNull(),
	label: text("label"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	revokedAt: text("revoked_at"),
	lastUsedAt: text("last_used_at"),
});
