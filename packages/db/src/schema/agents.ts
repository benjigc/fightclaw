import { sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const agents = sqliteTable("agents", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	apiKeyHash: text("api_key_hash").notNull(),
	verifiedAt: text("verified_at"),
	disabledAt: text("disabled_at"),
	claimCodeHash: text("claim_code_hash"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});
