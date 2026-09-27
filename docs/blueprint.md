# ChannelPitcher — Bot specification

**Archetype:** community

**Voice:** warm and concise — write every user-facing message, button label, error, and empty state in this voice.

Collect proposals (text + up to 10 photos) from channel subscribers, notify a single admin chat for review, allow admins to accept/reject/request changes with optional private notes, and optionally post accepted proposals back to the channel. Stores proposal metadata indefinitely and keeps Telegram media references while the files remain available (Telegram ~90 days).

> This is the complete contract for the bot. Implement EVERY entry point, flow, feature, integration, and edge case below. The completeness review checks the bot against this document after each build pass.

## Primary audience

- Telegram channel owners / moderators
- Channel subscribers and contributors

## Success criteria

- New proposal submitted and persisted with text and media references
- Admin receives notification for each new proposal (to ADMIN_CHAT_ID) with inline Review/Accept/Reject/Request actions
- Admin actions change proposal status and persist an admin note
- Accepted proposals optionally posted to the configured channel by the bot
- Submitter receives status updates and admin messages

## Entry points

Every feature must be reachable from the bot's command/button surface (button-first; only /start and /help are slash commands).

- **/start** (command, actor: user, command: /start) — Open the main menu and short instructions
  - outputs: menu message with Submit proposal button, brief usage instructions
- **Submit proposal** (button, actor: user, callback: proposal:new) — Start a new proposal submission flow (conversational)
  - inputs: free-form text (message), one or more photos (single message or media group; up to max photos)
  - outputs: proposal draft preview, optional contact prompt, Confirm / Cancel buttons
- **/help** (command, actor: user, command: /help) — Show help and short rules for submissions
  - outputs: help text

## Flows

### Submit proposal (happy path)
_Trigger:_ /start -> Submit proposal button or /submit command

1. Bot: explain brief instructions and ask for the proposal text or media
2. User: sends text and optionally photos (single message, media group, or multiple messages)
3. Bot: collects all messages within a short session window (e.g., 10 min) and shows draft preview
4. Bot: asks for optional contact info via ForceReply or button 'Skip'
5. User: provides contact or skips
6. Bot: shows Confirm / Edit / Cancel buttons
7. User: Confirm -> bot persists proposal, replies to user with confirmation, notifies ADMIN_CHAT_ID

_Data touched:_ Proposal, MediaAsset, User

### Admin review & actions
_Trigger:_ Notification message delivered to ADMIN_CHAT_ID

1. Bot: forwards proposal content (text + available photos) to ADMIN_CHAT_ID with inline buttons: Review, Accept, Reject, Request changes
2. Admin: taps an action
3. If Review -> opens admin review UI with option to add private note and change status
4. If Accept -> bot optionally posts proposal to CHANNEL_CHAT_ID (if auto-post enabled) and sets status=accepted; admin may add a note
5. If Reject -> bot prompts admin for optional rejection message to send to submitter; sets status=rejected and stores note
6. If Request changes -> bot prompts admin for change request text; sends change request to submitter and sets status=requested_changes

_Data touched:_ Proposal.status, AdminAction (note, actor_id, timestamp), User (notification history)

### Submitter response to Request changes
_Trigger:_ Submitter receives Request changes message and replies

1. Bot: routes submitter's reply into the original proposal thread as an updated draft (admin-visible)
2. Bot: notifies admin of the update and provides buttons to Accept/Reject/Request again
3. Admin: performs follow-up action

_Data touched:_ Proposal (edits appended or new revision stored), MediaAsset (if new media added)

### Auto-post enable / accept publish
_Trigger:_ Admin toggles auto-post OR taps Accept with auto-post enabled

1. Bot: verifies CHANNEL_CHAT_ID is configured and bot has admin/posting rights
2. Bot: posts proposal content to the configured channel as the bot (text + media group) and updates proposal.status to accepted
3. If posting fails -> bot stores error, notifies admin, and leaves proposal in review state

_Data touched:_ BotConfig, Proposal, MediaAsset

### Media lifecycle maintenance
_Trigger:_ Scheduled job or action on proposal view

1. System: retain media file IDs in metadata indefinitely but record their Telegram availability window
2. System: when files are no longer retrievable from Telegram, mark media asset as expired and show 'media expired' placeholder in admin / submitter views

_Data touched:_ MediaAsset (availability, expiry_flag), Proposal.metadata

## Owner-supplied settings

The OWNER provides these; they are collected in chat and injected into the environment at deploy. Read each one from the environment where it is used (`ctx.env.<KEY>` / `env.<KEY>` on Cloudflare Workers; `process.env.<KEY>` only as a Node/harness fallback — never the sole read). Do NOT invent your own way of learning the value, do NOT ask for it in a bot message, and do NOT hardcode a default.

- **ADMIN_CHAT_ID** — Telegram chat id where new proposals and admin notifications are sent
  - this is the OWNER's own chat id; the platform already knows it. Read `ADMIN_CHAT_ID` via `ctx.env` (prefer toolkit `adminChatId` / `requireOwner`) — never ask a user, never treat whoever writes first as the admin, never invent claim-admin or open manage for everyone.
  - may be UNSET at runtime: the bot must still start, and the feature needing ADMIN_CHAT_ID must say so plainly instead of failing.
- **CHANNEL_CHAT_ID** — Optional: channel chat id where accepted proposals are posted when auto-post is enabled
  - this is the OWNER's own chat id; the platform already knows it. Read `CHANNEL_CHAT_ID` via `ctx.env` (prefer toolkit `adminChatId` / `requireOwner`) — never ask a user, never treat whoever writes first as the admin, never invent claim-admin or open manage for everyone.
  - may be UNSET at runtime: the bot must still start, and the feature needing CHANNEL_CHAT_ID must say so plainly instead of failing.

Your behavioral specs run WITHOUT these values, so no spec may depend on one.

## Data entities

Durable data (must survive a restart) uses the toolkit's persistent store, never in-memory maps.

An entity that merely NAMES an owner-supplied setting above (an admin chat, an API account) is not something to store or discover — read it from the environment.

- **Proposal** _(retention: persistent)_ — Main submission record with content, media references, submitter, and status
  - fields: id ( UUID ), submitter_id (Telegram user id), submitter_name, contact_optional (string), text (string), media_file_ids (array of Telegram file_id), created_at, updated_at, status (new|reviewed|accepted|rejected|requested_changes), admin_notes (array of {admin_id, note, timestamp}), revision_history (optional)
- **User** _(retention: persistent)_ — Submitter profile minimal record
  - fields: user_id, display_name, telegram_username (optional), last_contact (timestamp)
- **MediaAsset** _(retention: persistent)_ — Telegram media reference and availability metadata (files hosted by Telegram)
  - fields: file_id, file_unique_id, media_type (photo), collected_at, available_until_estimate (based on Telegram TTL), expired_flag
- **AdminAction** _(retention: persistent)_ — Records of admin decisions and messages
  - fields: action_id, proposal_id, admin_id, action (review|accept|reject|request_changes|note), note (optional), timestamp
- **BotConfig** _(retention: persistent)_ — Owner-controlled bot settings
  - fields: admin_chat_id, channel_chat_id (optional), auto_post_enabled, max_photos_per_proposal, language

## Integrations

- **Telegram** (required) — Bot API messaging, forwarding, inline callbacks, media handling, and optional posting into channel
Call external APIs against their real contract (correct endpoints, ids, params); credentials from env. Do not fake responses.

## Owner controls

- Set ADMIN_CHAT_ID where new proposal notifications are sent
- Configure CHANNEL_CHAT_ID for posting accepted proposals (optional)
- Enable / disable auto-post to channel
- Set maximum photos per proposal (default 10)
- Change language
- View, archive, or delete proposals and media metadata
- Manually post an accepted proposal to the channel
- Export proposals metadata (CSV) on demand

## Notifications

- New proposal -> ADMIN_CHAT_ID with inline Review/Accept/Reject/Request changes buttons
- Submitter -> confirmation message after successful submission
- Submitter -> status updates when admin changes status (accepted/rejected/requested changes) including admin notes
- Admin -> notifications of submitter edits after Request changes (in ADMIN_CHAT_ID)
- Admin -> posting error notifications when posting to channel fails

## Permissions & privacy

- Store submitter Telegram id and provided contact to enable status updates and follow-up; submitter id is visible only to admins
- Media files are referenced by Telegram file_id; actual files are hosted by Telegram and subject to Telegram retention (~90 days). Bot stores metadata indefinitely but cannot guarantee file availability after Telegram expires them
- Admin notes are private and visible only to admins unless included in messages sent to submitter
- Owner/admins may delete proposals and associated metadata; deletion removes metadata but cannot remove files already posted in the channel
- Bot operations require the bot to be made admin in the target channel to post accepted proposals

## Edge cases

- Submitter sends media as multiple separate messages: system groups recent messages into one draft within a configurable short window (e.g., 10 minutes) — otherwise treated as multiple drafts
- User deletes their Telegram account: store submitter id until admin deletes proposal; notifications cannot be delivered to deleted accounts
- Telegram media expires (file_id invalid): admin/submitter views show 'media expired' placeholder and stored text remains
- Admin taps Accept but bot lacks permission to post to channel: bot reports error to admin and leaves proposal in review state
- Multiple admins attempt conflicting actions simultaneously: last action wins; admin actions are stamped and recorded for audit
- Spam/abusive submissions: owner can block submitter or enable moderation-only where admins must approve before notifying channel
- Large media groups over configured max photos: reject extra photos and ask user to resend or trim

## Required tests

- Dialog-level acceptance test: submitter submits text-only proposal -> persisted, admin notified, admin accepts -> optional post to channel
- Media grouping test: user sends media group and later adds photos within session window -> grouped into single proposal
- Admin action flows: Accept (with posting success and failure), Reject (with optional message delivered), Request changes (message delivered and reply routed back to admin)
- Media expiry handling: simulate Telegram file_id invalidation and show expired placeholder in admin and submitter views
- Permission error test: posting to channel when bot lacks channel admin rights returns clear admin-facing error and option to retry
- Deletion test: admin deletes a proposal and verifies metadata removed and submitter notifications stop

## Assumptions

- Single primary admin chat (ADMIN_CHAT_ID) is used for all notifications by default
- Language default is Russian; owner may request other languages later
- Max photos per proposal default is 10
- Bot will not perform AI rewriting or any content transformation
- Owner will grant the bot posting permission in the channel when enabling auto-post
