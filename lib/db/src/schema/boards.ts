import { sql } from "drizzle-orm";
import { bigint, boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

export type BoardRole = "owner" | "editor" | "commenter" | "viewer";
export type LinkAccess = "none" | "view" | "edit";
export type MemberSource = "link" | "direct" | "removed" | "left";

export const boardsTable = pgTable(
  "boards",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    title: varchar("title", { length: 200 }).notNull().default("Untitled board"),
    ownerId: varchar("owner_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // Excalidraw scene elements (array of element JSON). The realtime server is the writer.
    elements: jsonb("elements")
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Subset of Excalidraw appState worth persisting (background color, grid, etc.).
    appState: jsonb("app_state")
      .notNull()
      .default(sql`'{}'::jsonb`),
    // Share link: random token; access level for anyone holding the link.
    linkToken: varchar("link_token")
      .notNull()
      .default(sql`replace(gen_random_uuid()::text, '-', '')`),
    linkAccess: varchar("link_access").$type<LinkAccess>().notNull().default("none"),
    thumbnail: text("thumbnail"),
    sceneVersion: bigint("scene_version", { mode: "number" }).notNull().default(0),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("boards_owner_idx").on(t.ownerId), uniqueIndex("boards_link_token_idx").on(t.linkToken)],
);

export const boardMembersTable = pgTable(
  "board_members",
  {
    boardId: varchar("board_id")
      .notNull()
      .references(() => boardsTable.id, { onDelete: "cascade" }),
    userId: varchar("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    role: varchar("role").$type<BoardRole>().notNull().default("editor"),
    // How the person got access (team mode only): "link" (joined through the share link, so their access follows
    // the board's current link setting and ends when the link is turned off or reset), "direct" (the owner set their
    // role, which they keep even if the link is turned off), or "removed" (the owner removed them; the share link no
    // longer lets them in), or "left" (they left a board where the owner had set their role: the role stays as a
    // ceiling, and they need a working link to come back).
    source: varchar("source").$type<MemberSource>().notNull().default("link"),
    lastOpenedAt: timestamp("last_opened_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.boardId, t.userId] }), index("board_members_user_idx").on(t.userId)],
);

// Binary files referenced by image elements (Excalidraw BinaryFileData), stored as data URLs.
export const boardFilesTable = pgTable(
  "board_files",
  {
    boardId: varchar("board_id")
      .notNull()
      .references(() => boardsTable.id, { onDelete: "cascade" }),
    fileId: varchar("file_id").notNull(),
    mimeType: varchar("mime_type").notNull(),
    dataUrl: text("data_url").notNull(),
    sizeBytes: integer("size_bytes").notNull().default(0),
    createdBy: varchar("created_by").references(() => usersTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.boardId, t.fileId] })],
);

// Conversation with the board AI, shared by everyone on the board.
export const aiMessagesTable = pgTable(
  "ai_messages",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    boardId: varchar("board_id")
      .notNull()
      .references(() => boardsTable.id, { onDelete: "cascade" }),
    userId: varchar("user_id").references(() => usersTable.id, { onDelete: "set null" }),
    role: varchar("role").$type<"user" | "assistant">().notNull(),
    content: text("content").notNull(),
    // Extra context: focused element ids, attachment names, op counts, errors.
    meta: jsonb("meta")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ai_messages_board_idx").on(t.boardId, t.createdAt)],
);

// One row per AI request, used to enforce daily limits.
export const aiUsageTable = pgTable(
  "ai_usage",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    boardId: varchar("board_id"),
    kind: varchar("kind").notNull(),
    model: varchar("model"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /** Web searches and page fetches the board AI made during this run (capped per user per day). */
    webSearches: integer("web_searches").notNull().default(0),
    ok: boolean("ok").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ai_usage_user_idx").on(t.userId, t.createdAt)],
);

// Docs and decks generated from a board.
export const boardDocumentsTable = pgTable(
  "board_documents",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    boardId: varchar("board_id")
      .notNull()
      .references(() => boardsTable.id, { onDelete: "cascade" }),
    kind: varchar("kind").$type<"doc" | "deck">().notNull(),
    title: varchar("title", { length: 300 }).notNull(),
    // doc: { markdown }, deck: { slides: [{ title, bullets, notes }] }
    content: jsonb("content").notNull(),
    createdBy: varchar("created_by").references(() => usersTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("board_documents_board_idx").on(t.boardId)],
);

export type Board = typeof boardsTable.$inferSelect;
export type BoardMember = typeof boardMembersTable.$inferSelect;
export type AiMessage = typeof aiMessagesTable.$inferSelect;
export type BoardDocument = typeof boardDocumentsTable.$inferSelect;
