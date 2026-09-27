import { Composer, InputFile } from "grammy";
import type { Ctx } from "../bot.js";
import {
  adminChatId,
  inlineButton,
  inlineKeyboard,
  registerMainMenuItem,
  requireOwner,
} from "../toolkit/index.js";

registerMainMenuItem({ label: "📝 Submit proposal", data: "proposal:new", order: 10 });
registerMainMenuItem({ label: "⚙️ Owner controls", data: "proposal:settings", order: 90 });

type Step = "idle" | "content" | "contact" | "confirm" | "admin_note" | "requested_changes";
type Draft = { text: string; media: string[]; contact?: string; startedAt: number };
type FeatureSession = {
  proposalStep?: Step;
  proposalDraft?: Draft;
  proposalId?: string;
  adminAction?: "accept" | "reject" | "request_changes";
};
type Env = { DB?: unknown; ADMIN_CHAT_ID?: unknown; CHANNEL_CHAT_ID?: unknown };
type RuntimeCtx = Ctx & { env?: Env };

interface D1Result { results?: unknown[]; success?: boolean }
interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run(): Promise<D1Result>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}
interface D1Database { prepare(sql: string): D1Statement }

const MAX_PHOTOS = 10;
export let proposalClock = () => Date.now();
const now = () => proposalClock();

function session(ctx: RuntimeCtx): FeatureSession {
  return ctx.session as unknown as FeatureSession;
}

function database(ctx: RuntimeCtx): D1Database | undefined {
  return ctx.env?.DB as D1Database | undefined;
}

function channelId(ctx: RuntimeCtx): string | undefined {
  const value = ctx.env?.CHANNEL_CHAT_ID;
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof process !== "undefined" && process.env.CHANNEL_CHAT_ID?.trim()) {
    return process.env.CHANNEL_CHAT_ID.trim();
  }
  return undefined;
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `proposal-${now()}-${String(now())}`;
}

function contentKeyboard() {
  return inlineKeyboard([[inlineButton("Skip contact", "proposal:contact:skip")]]);
}

function confirmKeyboard() {
  return inlineKeyboard([
    [inlineButton("✅ Confirm", "proposal:confirm"), inlineButton("✏️ Edit", "proposal:edit")],
    [inlineButton("Cancel", "proposal:cancel")],
  ]);
}

function adminKeyboard(id: string) {
  return inlineKeyboard([
    [inlineButton("Review", `proposal:review:${id}`)],
    [inlineButton("Accept", `proposal:accept:${id}`), inlineButton("Reject", `proposal:reject:${id}`)],
    [inlineButton("Request changes", `proposal:changes:${id}`)],
    [inlineButton("Post manually", `proposal:post:${id}`), inlineButton("Delete", `proposal:delete:${id}`)],
  ]);
}

async function ensureSchema(db: D1Database): Promise<void> {
  await db.prepare(`CREATE TABLE IF NOT EXISTS proposals (
    id TEXT PRIMARY KEY, submitter_id TEXT NOT NULL, submitter_name TEXT NOT NULL,
    contact TEXT, text TEXT NOT NULL, media_json TEXT NOT NULL, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, status TEXT NOT NULL, notes_json TEXT NOT NULL, revisions_json TEXT NOT NULL,
    post_error TEXT
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, username TEXT, last_contact INTEGER NOT NULL
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS media_assets (
    file_id TEXT PRIMARY KEY, file_unique_id TEXT, media_type TEXT NOT NULL, collected_at INTEGER NOT NULL,
    available_until_estimate INTEGER NOT NULL, expired_flag INTEGER NOT NULL
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS admin_actions (
    action_id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, admin_id TEXT NOT NULL, action TEXT NOT NULL,
    note TEXT, timestamp INTEGER NOT NULL
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS bot_config (id INTEGER PRIMARY KEY, auto_post_enabled INTEGER NOT NULL)`).run();
}

async function saveProposal(ctx: RuntimeCtx, draft: Draft): Promise<string> {
  const id = newId();
  const db = database(ctx);
  if (!db) return id;
  await ensureSchema(db);
  const user = ctx.from;
  const t = now();
  await db.prepare("INSERT OR REPLACE INTO users (user_id, display_name, username, last_contact) VALUES (?, ?, ?, ?)")
    .bind(String(user?.id ?? ctx.chat?.id ?? ""), user?.first_name ?? "Contributor", user?.username ?? null, t).run();
  await db.prepare("INSERT INTO proposals (id, submitter_id, submitter_name, contact, text, media_json, created_at, updated_at, status, notes_json, revisions_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, String(user?.id ?? ctx.chat?.id ?? ""), user?.first_name ?? "Contributor", draft.contact ?? null, draft.text,
      JSON.stringify(draft.media), t, t, "new", "[]", "[]").run();
  for (const fileId of draft.media) {
    await db.prepare("INSERT OR REPLACE INTO media_assets (file_id, file_unique_id, media_type, collected_at, available_until_estimate, expired_flag) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(fileId, null, "photo", t, t + 90 * 24 * 60 * 60 * 1000, 0).run();
  }
  return id;
}

async function proposal(ctx: RuntimeCtx, id: string): Promise<Record<string, unknown> | null> {
  const db = database(ctx);
  if (!db) return null;
  await ensureSchema(db);
  return db.prepare("SELECT * FROM proposals WHERE id = ?").bind(id).first();
}

async function latestRequested(ctx: RuntimeCtx): Promise<Record<string, unknown> | null> {
  const db = database(ctx);
  if (!db || !ctx.from) return null;
  await ensureSchema(db);
  return db.prepare("SELECT * FROM proposals WHERE submitter_id = ? AND status = ? ORDER BY updated_at DESC LIMIT 1")
    .bind(String(ctx.from.id), "requested_changes").first();
}

async function action(ctx: RuntimeCtx, id: string, status: string, note?: string): Promise<boolean> {
  const db = database(ctx);
  if (!db) return false;
  await ensureSchema(db);
  const t = now();
  const row = await proposal(ctx, id);
  if (!row) return false;
  const notes = JSON.parse(String(row.notes_json ?? "[]")) as unknown[];
  if (note?.trim()) notes.push({ admin_id: String(ctx.from?.id ?? ""), note: note.trim(), timestamp: t });
  await db.prepare("UPDATE proposals SET status = ?, updated_at = ?, notes_json = ? WHERE id = ?")
    .bind(status, t, JSON.stringify(notes), id).run();
  await db.prepare("INSERT INTO admin_actions (action_id, proposal_id, admin_id, action, note, timestamp) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(newId(), id, String(ctx.from?.id ?? ""), status === "requested_changes" ? "request_changes" : status, note ?? null, t).run();
  return true;
}

async function expireUnavailableMedia(ctx: RuntimeCtx, row: Record<string, unknown>): Promise<number> {
  const ids = JSON.parse(String(row.media_json ?? "[]")) as string[];
  const db = database(ctx);
  let expired = 0;
  for (const fileId of ids) {
    try { await ctx.api.getFile(fileId); }
    catch {
      expired++;
      if (db) await db.prepare("UPDATE media_assets SET expired_flag = 1 WHERE file_id = ?").bind(fileId).run();
    }
  }
  return expired;
}

async function safeNotify(ctx: RuntimeCtx, chatId: string, text: string): Promise<void> {
  try { await ctx.api.sendMessage(chatId, text); } catch { /* a deleted/blocked account must not stop review */ }
}

async function postAccepted(ctx: RuntimeCtx, row: Record<string, unknown>, force = false): Promise<"posted" | "skipped" | "failed"> {
  const destination = channelId(ctx);
  if (!destination) return "skipped";
  const db = database(ctx);
  if (db) {
    await ensureSchema(db);
    const config = await db.prepare("SELECT auto_post_enabled FROM bot_config WHERE id = 1").first<{ auto_post_enabled: number }>();
    if (!force && config?.auto_post_enabled !== 1) return "skipped";
  } else return "skipped";
  const text = String(row.text ?? "");
  const media = JSON.parse(String(row.media_json ?? "[]")) as string[];
  try {
    if (media.length === 0) await ctx.api.sendMessage(destination, text);
    else if (media.length === 1) await ctx.api.sendPhoto(destination, media[0], { caption: text });
    else await ctx.api.sendMediaGroup(destination, media.map((fileId, i) => ({ type: "photo" as const, media: fileId, caption: i === 0 ? text : undefined })));
    return "posted";
  } catch { return "failed"; }
}

const composer = new Composer<Ctx>();

composer.callbackQuery("proposal:new", async (ctx) => {
  await ctx.answerCallbackQuery();
  const s = session(ctx as RuntimeCtx);
  s.proposalStep = "content";
  s.proposalDraft = { text: "", media: [], startedAt: now() };
  await ctx.reply("Send your proposal text and any photos. You can add up to 10 photos.", {
    reply_markup: { force_reply: true, input_field_placeholder: "Write your proposal…" },
  });
});

composer.callbackQuery("proposal:contact:skip", async (ctx) => {
  await ctx.answerCallbackQuery();
  const s = session(ctx as RuntimeCtx);
  if (!s.proposalDraft) { await ctx.reply("Your draft has expired. Tap Submit proposal to start again."); return; }
  s.proposalStep = "confirm";
  await ctx.reply(preview(s.proposalDraft), { reply_markup: confirmKeyboard() });
});

composer.callbackQuery("proposal:cancel", async (ctx) => {
  await ctx.answerCallbackQuery();
  const s = session(ctx as RuntimeCtx); delete s.proposalStep; delete s.proposalDraft;
  await ctx.editMessageText("Your draft was cancelled.");
});

composer.callbackQuery("proposal:edit", async (ctx) => {
  await ctx.answerCallbackQuery();
  session(ctx as RuntimeCtx).proposalStep = "content";
  await ctx.reply("Send the updated proposal text or another photo.", { reply_markup: { force_reply: true, input_field_placeholder: "Update your proposal…" } });
});

composer.callbackQuery("proposal:confirm", async (ctx) => {
  await ctx.answerCallbackQuery();
  const runtime = ctx as RuntimeCtx; const s = session(runtime);
  if (!s.proposalDraft || (!s.proposalDraft.text.trim() && s.proposalDraft.media.length === 0)) {
    await ctx.reply("Add some text or a photo before confirming."); return;
  }
  const id = await saveProposal(runtime, s.proposalDraft); s.proposalId = id;
  s.proposalStep = "idle"; const admin = adminChatId(runtime);
  await ctx.reply("Your proposal is saved. The owner will review it soon.");
  if (!admin) { await ctx.reply("Owner review notifications aren't set up yet."); return; }
  const row = await proposal(runtime, id);
  const label = `New proposal\n\n${s.proposalDraft.text || "(Photo proposal)"}`;
  try {
    await ctx.api.sendMessage(admin, label, { reply_markup: adminKeyboard(id) });
    if (row) {
      const media = JSON.parse(String(row.media_json ?? "[]")) as string[];
      for (const fileId of media) await ctx.api.sendPhoto(admin, fileId);
    }
  } catch { await ctx.reply("Your proposal is saved, but the owner could not be notified yet."); }
});

composer.callbackQuery(/^proposal:(review|accept|reject|changes):(.+)$/, async (ctx) => {
  const runtime = ctx as RuntimeCtx;
  if (!(await requireOwner(runtime as unknown as Parameters<typeof requireOwner>[0]))) return;
  await ctx.answerCallbackQuery();
  const match = /^proposal:(review|accept|reject|changes):(.+)$/.exec(ctx.callbackQuery.data);
  if (!match) return;
  const kind = match[1]; const id = match[2]; const row = await proposal(runtime, id);
  if (!row) { await ctx.reply("That proposal is no longer available."); return; }
  if (kind === "review") {
    const expired = await expireUnavailableMedia(runtime, row);
    await action(runtime, id, "reviewed");
    await ctx.reply(`Proposal\n\n${String(row.text || "(Photo proposal)")}\n\nStatus: ${String(row.status)}${expired ? `\n\nMedia expired: ${expired}` : ""}`, { reply_markup: adminKeyboard(id) });
  } else if (kind === "accept") {
    const posted = await postAccepted(runtime, row);
    if (posted === "failed") { await ctx.reply("I couldn't post this to the channel. Check the bot's channel admin rights and try again."); return; }
    const s = session(runtime); s.proposalId = id; s.adminAction = "accept"; s.proposalStep = "admin_note";
    await ctx.reply(posted === "posted" ? "Accepted and posted. Add an optional private note, or tap Skip." : "Accepted. Add an optional private note, or tap Skip.", { reply_markup: inlineKeyboard([[inlineButton("Skip", "proposal:admin-skip")]]) });
  } else {
    const s = session(runtime); s.proposalId = id; s.adminAction = kind === "reject" ? "reject" : "request_changes"; s.proposalStep = "admin_note";
    await ctx.reply(kind === "reject" ? "Send an optional note for the contributor, or tap Skip." : "Tell the contributor what to change.", { reply_markup: inlineKeyboard([[inlineButton("Skip", "proposal:admin-skip")]]) });
  }
});

composer.callbackQuery("proposal:admin-skip", async (ctx) => {
  const runtime = ctx as RuntimeCtx; if (!(await requireOwner(runtime as unknown as Parameters<typeof requireOwner>[0]))) return; await ctx.answerCallbackQuery();
  await finishAdminAction(runtime, "");
});

composer.callbackQuery("proposal:settings", async (ctx) => {
  const runtime = ctx as RuntimeCtx;
  if (!(await requireOwner(runtime as unknown as Parameters<typeof requireOwner>[0]))) return;
  await ctx.answerCallbackQuery();
  await ctx.reply("Owner controls", { reply_markup: inlineKeyboard([
    [inlineButton("Toggle auto-post", "proposal:toggle-auto")],
    [inlineButton("View proposals", "proposal:list")],
    [inlineButton("Export CSV", "proposal:export")],
  ]) });
});

composer.callbackQuery("proposal:toggle-auto", async (ctx) => {
  const runtime = ctx as RuntimeCtx;
  if (!(await requireOwner(runtime as unknown as Parameters<typeof requireOwner>[0]))) return;
  await ctx.answerCallbackQuery();
  const db = database(runtime);
  if (!db) { await ctx.reply("Owner settings aren't connected yet."); return; }
  await ensureSchema(db);
  const current = await db.prepare("SELECT auto_post_enabled FROM bot_config WHERE id = 1").first<{ auto_post_enabled: number }>();
  const enabled = current?.auto_post_enabled === 1 ? 0 : 1;
  await db.prepare("INSERT OR REPLACE INTO bot_config (id, auto_post_enabled) VALUES (1, ?)").bind(enabled).run();
  await ctx.reply(enabled ? "Auto-post is on." : "Auto-post is off.");
});

composer.callbackQuery("proposal:list", async (ctx) => {
  const runtime = ctx as RuntimeCtx;
  if (!(await requireOwner(runtime as unknown as Parameters<typeof requireOwner>[0]))) return;
  await ctx.answerCallbackQuery();
  const db = database(runtime);
  if (!db) { await ctx.reply("Proposal storage isn't connected yet."); return; }
  await ensureSchema(db);
  const rows = await db.prepare("SELECT id, text, status FROM proposals ORDER BY updated_at DESC LIMIT 20").all<{ id: string; text: string; status: string }>();
  if (!rows.results.length) { await ctx.reply("No proposals yet — new submissions will appear here."); return; }
  await ctx.reply(rows.results.map((r) => `${r.status}: ${r.text.slice(0, 80)}`).join("\n"));
});

composer.callbackQuery(/^proposal:delete:(.+)$/, async (ctx) => {
  const runtime = ctx as RuntimeCtx;
  if (!(await requireOwner(runtime as unknown as Parameters<typeof requireOwner>[0]))) return;
  await ctx.answerCallbackQuery();
  const id = /^proposal:delete:(.+)$/.exec(ctx.callbackQuery.data)?.[1];
  const db = database(runtime);
  if (!id || !db) { await ctx.reply("Proposal storage isn't connected yet."); return; }
  await ensureSchema(db);
  const row = await proposal(runtime, id);
  const ids = row ? JSON.parse(String(row.media_json ?? "[]")) as string[] : [];
  await db.prepare("DELETE FROM admin_actions WHERE proposal_id = ?").bind(id).run();
  for (const fileId of ids) await db.prepare("DELETE FROM media_assets WHERE file_id = ?").bind(fileId).run();
  await db.prepare("DELETE FROM proposals WHERE id = ?").bind(id).run();
  await ctx.reply("The proposal and its metadata were deleted.");
});

composer.callbackQuery(/^proposal:post:(.+)$/, async (ctx) => {
  const runtime = ctx as RuntimeCtx;
  if (!(await requireOwner(runtime as unknown as Parameters<typeof requireOwner>[0]))) return;
  await ctx.answerCallbackQuery();
  const id = /^proposal:post:(.+)$/.exec(ctx.callbackQuery.data)?.[1];
  const row = id ? await proposal(runtime, id) : null;
  if (!row || String(row.status) !== "accepted") { await ctx.reply("Only an accepted proposal can be posted."); return; }
  const destination = channelId(runtime);
  if (!destination) { await ctx.reply("The channel isn't set up yet."); return; }
  const previous = await postAccepted(runtime, { ...row, media_json: row.media_json }, true);
  if (previous === "failed") { await ctx.reply("I couldn't post this to the channel. Check the bot's channel admin rights and try again."); return; }
  await ctx.reply(previous === "posted" ? "Posted to the channel." : "Auto-post is off. Turn it on first.");
});

composer.callbackQuery("proposal:export", async (ctx) => {
  const runtime = ctx as RuntimeCtx;
  if (!(await requireOwner(runtime as unknown as Parameters<typeof requireOwner>[0]))) return;
  await ctx.answerCallbackQuery();
  const db = database(runtime);
  if (!db) { await ctx.reply("Proposal storage isn't connected yet."); return; }
  await ensureSchema(db);
  const rows = await db.prepare("SELECT id, submitter_id, text, status, created_at, updated_at FROM proposals ORDER BY created_at ASC").all<Record<string, unknown>>();
  const csv = ["id,submitter_id,text,status,created_at,updated_at", ...rows.results.map((r) => [r.id, r.submitter_id, r.text, r.status, r.created_at, r.updated_at].map((v) => `\"${String(v ?? "").replaceAll('"', '""')}\"`).join(","))].join("\n");
  await ctx.api.sendDocument(ctx.chat!.id, new InputFile(new TextEncoder().encode(csv), "proposals.csv"));
});

composer.on("message", async (ctx, next) => {
  const runtime = ctx as RuntimeCtx; const s = session(runtime); const message = ctx.message;
  if (message && "text" in message && (message.text ?? "").startsWith("/")) return next();
  if (s.proposalStep === "admin_note" && message && "text" in message) { await finishAdminAction(runtime, message.text ?? ""); return; }
  if (s.proposalStep === "requested_changes" && message && ("text" in message || "photo" in message)) { await recordRevision(runtime, message); return; }
  if (!s.proposalStep && message && ("text" in message || "photo" in message)) {
    const requested = await latestRequested(runtime);
    if (requested) {
      s.proposalId = String(requested.id);
      s.proposalStep = "requested_changes";
      await recordRevision(runtime, message);
      return;
    }
  }
  if ((s.proposalStep !== "content" && s.proposalStep !== "contact") || !s.proposalDraft || !message) return next();
  const photos = "photo" in message && message.photo ? [message.photo[message.photo.length - 1].file_id] : [];
  if (photos.length && s.proposalDraft.media.length + photos.length > MAX_PHOTOS) {
    await ctx.reply("That’s more than 10 photos. Remove the extras and send them again.");
    return;
  }
  if (photos.length) s.proposalDraft.media.push(...photos);
  const incomingText = "text" in message ? (message.text ?? "").trim() : "";
  if (incomingText) {
    if (s.proposalStep === "content" && !s.proposalDraft.text) s.proposalDraft.text = incomingText;
    else s.proposalDraft.contact = incomingText;
  }
  if (s.proposalDraft.media.length > MAX_PHOTOS) { await ctx.reply("That’s more than 10 photos. Remove the extras and send them again."); return; }
  if (s.proposalStep === "content") {
    s.proposalStep = "contact";
    await ctx.reply("Would you like to leave a contact for the owner? Send it, or tap Skip.", { reply_markup: contentKeyboard() });
  } else {
    s.proposalStep = "confirm";
    await ctx.reply(preview(s.proposalDraft), { reply_markup: confirmKeyboard() });
  }
});

function preview(draft: Draft): string {
  const text = draft.text.trim() || "(Photo proposal)";
  return `Here’s your proposal:\n\n${text}\n\nPhotos: ${draft.media.length}\nContact: ${draft.contact || "Not provided"}\n\nReady to send it?`;
}

async function finishAdminAction(ctx: RuntimeCtx, note: string): Promise<void> {
  const s = session(ctx); if (!s.proposalId || !s.adminAction) { await ctx.reply("That review has expired."); return; }
  const row = await proposal(ctx, s.proposalId); if (!row) { await ctx.reply("That proposal is no longer available."); return; }
  const status = s.adminAction === "accept" ? "accepted" : s.adminAction === "reject" ? "rejected" : "requested_changes";
  await action(ctx, s.proposalId, status, note);
  await safeNotify(ctx, String(row.submitter_id), status === "accepted" ? "Your proposal was accepted. Thanks for sharing it!" : status === "rejected" ? `Your proposal was declined.${note ? `\n\n${note}` : ""}` : `The owner asked for changes.${note ? `\n\n${note}` : ""}`);
  if (status === "requested_changes") { s.proposalStep = "idle"; s.proposalId = s.proposalId; }
  else { delete s.proposalStep; delete s.proposalId; }
  await ctx.reply(status === "accepted" ? "Accepted and the contributor was notified." : status === "rejected" ? "Rejected and the contributor was notified." : "Change request sent.");
}

async function recordRevision(ctx: RuntimeCtx, message: NonNullable<RuntimeCtx["message"]>): Promise<void> {
  const s = session(ctx); if (!s.proposalId) return;
  const db = database(ctx); if (!db) { await ctx.reply("Your reply was received, but review storage isn't set up yet."); return; }
  const row = await proposal(ctx, s.proposalId); if (!row) { await ctx.reply("That proposal is no longer available."); return; }
  const text = "text" in message ? message.text : "(New photos)";
  const media = "photo" in message && message.photo ? [message.photo[message.photo.length - 1].file_id] : [];
  const revisions = JSON.parse(String(row.revisions_json ?? "[]")) as unknown[];
  revisions.push({ text, media, timestamp: now() });
  await db.prepare("UPDATE proposals SET revisions_json = ?, updated_at = ?, status = ? WHERE id = ?").bind(JSON.stringify(revisions), now(), "reviewed", s.proposalId).run();
  const admin = adminChatId(ctx); if (admin) await ctx.api.sendMessage(admin, `The contributor updated proposal ${s.proposalId}.`, { reply_markup: adminKeyboard(s.proposalId) });
  s.proposalStep = "idle"; await ctx.reply("Thanks — your update is with the owner.");
}

export default composer;
