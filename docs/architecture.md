# Architecture

Velo follows a **three-layer architecture** with clear separation of concerns.

```
+--------------------------+
|     React 19 + Zustand   |   UI Layer
|  Components + 7 Stores   |   (TypeScript)
+--------------------------+
|     Service Layer         |   Business Logic
|  Email Provider / Gmail / |   (TypeScript)
|  IMAP / DB / Sync /       |
|  Filters / Notifications  |
+--------------------------+
|     Tauri v2 + Rust       |   Native Layer
|  System Tray / OAuth /    |   (Rust)
|  SQLite / Notifications / |
|  Deep Links / Autostart   |
+--------------------------+
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Framework** | [Tauri v2](https://v2.tauri.app/) |
| **Frontend** | React 19, TypeScript, Zustand 5 |
| **Styling** | Tailwind CSS v4 |
| **Editor** | TipTap v3 |
| **Backend** | Rust |
| **Database** | SQLite (via tauri-plugin-sql) |
| **Search** | FTS5 with trigram tokenizer |
| **AI** | Provider plumbing only (Claude, OpenAI, Gemini, Ollama, Copilot) -- not wired to any active feature, kept for future use via Settings > AI |
| **Icons** | Lucide React |
| **Drag & Drop** | @dnd-kit |
| **Testing** | Vitest + Testing Library |

## Data Flow

1. **Sync** -- Background sync every 60s. Gmail accounts use Gmail History API (delta sync, falls back to full sync if history expires ~30 days). IMAP accounts use UIDVALIDITY/last_uid tracking for efficient delta sync.
2. **Storage** -- All messages, threads, labels, and contacts stored in local SQLite (35 tables, some dormant from removed features -- see Database section) with FTS5 full-text indexing.
3. **State** -- Seven Zustand stores manage UI state. No middleware, no persistence needed -- ephemeral state rebuilds from SQLite on startup.
4. **Rendering** -- Email HTML is sanitized with DOMPurify and rendered in sandboxed iframes. Remote images blocked by default.
5. **Background services** -- Six interval checkers run continuously: sync (60s), snooze (60s), scheduled send (60s), follow-up reminders (60s), offline queue processor (30s), and attachment pre-cache (15min).
6. **Security** -- Phishing link detection scores message links with 10 heuristic rules. SPF/DKIM/DMARC authentication headers parsed and displayed as badges.

## Project Structure

```
velo/
├── src/
│   ├── components/           # React components (9 groups, ~65 files)
│   │   ├── layout/           # Sidebar, EmailList, MailLayout, ReadingPane, TitleBar
│   │   ├── email/            # ThreadView, MessageItem, EmailRenderer,
│   │   │                     # ContactSidebar, InlineReply, FollowUpDialog,
│   │   │                     # AuthBadge, AuthWarningBanner, PhishingBanner,
│   │   │                     # LinkConfirmDialog, MoveToFolderDialog
│   │   ├── composer/         # Composer, AddressInput, EditorToolbar,
│   │   │                     # ScheduleSendDialog, FromSelector
│   │   ├── search/           # CommandPalette, SearchBar, ShortcutsHelp
│   │   ├── settings/         # SettingsPage, FilterEditor, LabelEditor,
│   │   │                     # SubscriptionManager, ContactEditor
│   │   ├── accounts/         # AddAccount, AddImapAccount, AccountSwitcher, SetupClientId
│   │   ├── labels/           # LabelForm
│   │   ├── dnd/              # DndProvider (drag threads → sidebar labels)
│   │   └── ui/               # EmptyState, Skeleton, ContextMenu, OfflineBanner, illustrations/
│   ├── services/             # Business logic layer
│   │   ├── db/               # SQLite queries (24 files), migrations, FTS5
│   │   ├── email/            # EmailProvider abstraction, providerFactory,
│   │   │                     # gmailProvider, imapSmtpProvider
│   │   ├── gmail/            # GmailClient, tokenManager, syncManager
│   │   ├── imap/             # IMAP sync, folder mapper, auto-discovery,
│   │   │                     # config builder, Tauri command wrappers
│   │   ├── threading/        # JWZ threading engine for IMAP conversations
│   │   ├── ai/               # Provider plumbing only (Claude/OpenAI/Gemini/
│   │   │                     # Ollama/Copilot) -- not wired to any feature
│   │   ├── composer/         # Draft auto-save
│   │   ├── search/           # Query parser, SQL builder
│   │   ├── filters/          # Auto-apply filter engine
│   │   ├── snooze/           # Snooze & scheduled send checkers
│   │   ├── followup/         # Follow-up reminder checker
│   │   ├── notifications/    # OS notification manager
│   │   ├── contacts/         # Gravatar integration
│   │   ├── attachments/      # Attachment cache manager, pre-cache manager
│   │   ├── unsubscribe/      # One-click unsubscribe (RFC 8058)
│   │   ├── queue/            # Offline queue processor
│   │   ├── emailActions.ts   # Centralized email action service (offline-aware)
│   │   ├── badgeManager.ts   # Taskbar badge count
│   │   ├── deepLinkHandler.ts # mailto: protocol handler
│   │   └── globalShortcut.ts # System-wide compose shortcut
│   ├── stores/               # Zustand stores (7): ui, account, thread,
│   │                         # composer, label, contextMenu, shortcut
│   ├── hooks/                # useKeyboardShortcuts, useClickOutside, useContextMenu
│   ├── utils/                # crypto, date, emailBuilder, sanitize, imageBlocker,
│   │                         # mailtoParser, fileUtils, templateVariables, noReply
│   ├── constants/            # Keyboard shortcuts, color themes
│   └── styles/               # Tailwind CSS v4 globals
├── src-tauri/
│   ├── src/                  # Rust backend (tray, OAuth, splash, single-instance,
│   │   │                     # IMAP client, SMTP client, Tauri commands)
│   ├── capabilities/         # Tauri v2 permissions
│   └── icons/                # App icons (all platforms)
├── docs/                     # Documentation
├── package.json
├── CLAUDE.md                 # AI coding assistant context
└── README.md
```

## Rust Backend

The Rust layer (`src-tauri/src/`) handles system integration and performance-critical email protocol operations. It provides:

- **System tray** -- Show/hide, check mail, quit menu
- **OAuth server** -- Localhost PKCE server on port 17248
- **IMAP client** (`imap/`) -- Full IMAP protocol via `async-imap` + `mail-parser`. Supports TLS/STARTTLS/plain, XOAuth2 auth. Operations: FETCH, STORE, MOVE, DELETE, APPEND, LIST, STATUS
- **SMTP client** (`smtp/`) -- Email sending via `lettre`. Supports TLS/STARTTLS/plain. Parses RFC 2822 envelopes
- **Splash screen** -- Shown during initialization, closed when ready
- **Single instance** -- Prevents duplicate app windows, forwards deep link args
- **Minimize to tray** -- Hides on close instead of quitting
- **Custom titlebar** -- Overlay on macOS, frameless on Windows/Linux
- **Windows AUMID** -- Set for proper notification identity

**Tauri commands:** `start_oauth_server`, `close_splashscreen`, `set_tray_tooltip`, `open_devtools`, 11 IMAP commands (`imap_test_connection`, `imap_list_folders`, `imap_fetch_messages`, etc.), 2 SMTP commands (`smtp_send_email`, `smtp_test_connection`)

**Plugins (13):** sql, notification, opener, log, dialog, fs, http, single-instance, autostart, deep-link, global-shortcut

**Rust dependencies (IMAP/SMTP):** `async-imap`, `tokio-native-tls`, `mail-parser`, `lettre`

## Service Layer

All business logic lives in `src/services/` as plain async functions (except `GmailClient` class). Email operations use the `EmailProvider` abstraction — all sync/send flows go through `providerFactory.ts` which returns the appropriate provider (Gmail API or IMAP/SMTP) based on the account type.

| Service | Description |
|---------|-------------|
| `db/` | SQLite queries (24 files), migrations, FTS5 search |
| `email/` | EmailProvider abstraction, provider factory, Gmail/IMAP adapters |
| `gmail/` | Gmail client, token management, sync engine |
| `imap/` | IMAP sync, folder-to-label mapping, auto-discovery, Tauri command wrappers |
| `threading/` | JWZ threading algorithm for IMAP message grouping |
| `ai/` | Provider plumbing only (Claude, OpenAI, Gemini, Ollama, Copilot) -- not wired to any active feature, kept for future use |
| `composer/` | Draft auto-save (3s debounce) |
| `search/` | Gmail-style query parser, SQL builder |
| `filters/` | Auto-apply filter engine (AND logic) |
| `snooze/` | Snooze & scheduled send background checkers |
| `followup/` | Follow-up reminder checker |
| `notifications/` | OS notifications; VIP-only filtering applies only when smart mode is on AND VIPs are configured |
| `contacts/` | Gravatar integration |
| `attachments/` | Local attachment caching, pre-cache recent attachments |
| `unsubscribe/` | One-click unsubscribe (RFC 8058) |
| `queue/` | Offline queue processor with exponential backoff |

**Root-level services:** `emailActions.ts` (centralized offline-aware email actions), `badgeManager.ts` (taskbar badge), `deepLinkHandler.ts` (mailto: protocol), `globalShortcut.ts` (system-wide compose)

## UI Layer

Seven Zustand stores manage ephemeral UI state:

| Store | Purpose |
|-------|---------|
| `uiStore` | Theme, sidebar, sidebar nav config, reading pane, density, font scale, selections, online status, pending ops count |
| `accountStore` | Account list, active account |
| `threadStore` | Thread list, selected thread, loading state |
| `composerStore` | Compose state, recipients, body, attachments |
| `labelStore` | Label list, label operations |
| `contextMenuStore` | Right-click context menu state |
| `shortcutStore` | Custom keyboard shortcut bindings |

## Database

SQLite via Tauri SQL plugin. 19 migrations, 35 tables total.

Key tables: `accounts` (with `provider`, IMAP/SMTP fields), `messages` (with FTS5 index, `auth_results`, IMAP headers, `imap_uid`, `imap_folder`), `threads` (with `is_pinned`, `is_muted`), `thread_labels`, `labels` (with `imap_folder_path`, `imap_special_use`), `contacts`, `attachments` (with `imap_part_id`), `filter_rules`, `scheduled_emails`, `templates`, `signatures`, `image_allowlist`, `settings`, `follow_up_reminders`, `notification_vips`, `unsubscribe_actions`, `send_as_aliases`, `link_scan_results`, `phishing_allowlist`, `folder_sync_state` (IMAP sync tracking), `pending_operations` (offline action queue), `local_drafts` (offline draft persistence).

**Dormant tables** (schema-only leftovers from removed features; `migrations.ts` is never edited retroactively so these are never dropped) with no reachable code path at runtime: `ai_cache` (`db/aiCache.ts` still defines queries for it but is kept, currently caller-less, as part of the AI provider plumbing for future features), `thread_categories`, `calendar_events`, `calendars`, `bundle_rules`, `bundled_threads`, `smart_folders`, `quick_steps`, `writing_style_profiles`, `tasks`, `task_tags`, `smart_label_rules`.

## Startup Sequence

1. Run database migrations
2. Restore persisted settings (theme, sidebar, density, font scale, reading pane, etc.)
3. Load custom keyboard shortcuts
4. Initialize email providers for all accounts (Gmail API clients + IMAP providers), sync send-as aliases for Gmail accounts
5. Start background sync (60s interval)
6. Start background checkers (snooze, scheduled send, follow-up, queue processor, attachment pre-cache)
7. Initialize network status detection (online/offline listeners)
8. Initialize OS notifications
9. Register global compose shortcut
10. Initialize deep link handler (`mailto:`)
11. Update taskbar badge count
12. Close splash screen, show main window

## Packaging & Distribution

Velo supports standard Linux distribution formats via automated and local build processes:

- **RPM & COPR**: Native RPM generation is integrated via Tauri's bundler (`tauri build -b rpm`), making it trivial to build and test RPMs locally or publish SRPMs to Fedora COPR.
- **Flatpak**: A Flatpak manifest (`com.velomail.app.yml`) defines the sandbox environment, leveraging the GNOME 46 runtime and Rust/Node.js SDK extensions. Local builds are streamlined via an npm script (`npm run flatpak`) which uses `flatpak-builder` while excluding host-specific artifacts to ensure reproducible sandboxed builds.
