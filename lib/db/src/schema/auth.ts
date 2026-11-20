import { index, jsonb, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";

export type PersonKind = "owner" | "guest";

/**
 * People who use this install. There is always exactly one owner (id "owner"), created on first start. In team
 * mode, everyone who joins a board through its share link gets a guest row with the name they typed.
 */
export const usersTable = pgTable("users", {
  id: varchar("id").primaryKey(),
  displayName: varchar("display_name", { length: 80 }).notNull(),
  kind: varchar("kind").$type<PersonKind>().notNull().default("guest"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** Browser sessions, used only in team mode (solo mode treats every local request as the owner). */
export const sessionsTable = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    userId: varchar("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    expire: timestamp("expire", { withTimezone: true }).notNull(),
  },
  (t) => [index("sessions_expire_idx").on(t.expire), index("sessions_user_idx").on(t.userId)],
);

/** Install-wide state, such as the owner link token. */
export const settingsTable = pgTable("settings", {
  key: varchar("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type User = typeof usersTable.$inferSelect;
