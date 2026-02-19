import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const runnerAgentOwnership = sqliteTable(
	"runner_agent_ownership",
	{
		runnerId: text("runner_id").notNull(),
		agentId: text("agent_id").notNull(),
		createdAt: text("created_at").notNull(),
		revokedAt: text("revoked_at"),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.runnerId, table.agentId] }),
	}),
);
