# leap 🦊

An MCP server for [openGym](https://gitlab.com/DuarteSantos8/opengym): lets AI
assistants log, edit and analyze your workouts, routines, body weight and PRs on
your self-hosted instance, through openGym's own HTTP API.
Tested against openGym 1.4.0. Releases are listed in [CHANGELOG.md](CHANGELOG.md).

- **Full coverage.** Everything the openGym API offers a signed-in profile:
  training data, stats, media, the AI Coach, account and admin.
- **Runs on your machine, talks to your server.** No SSH, no extra container,
  nothing to install on the server. leap signs in like the phone app does.
- **Safe writes.** openGym stores a profile as one document. leap changes only
  what you asked for, keeps every field it does not know, stamps every change
  the way the app does so devices merge it field by field, and refuses to
  overwrite changes made on another device in the meantime.
- **Simple permissions.** Tools are grouped by tier, so an MCP client needs one
  rule per tier.

## Requirements

- Node.js 22.12 or newer (`npx` comes with it)
- An openGym instance reachable over https, version 1.4.0 or later (see
  [Compatibility](#compatibility))
- A token: in openGym open **Settings → Pair the mobile app**, then run

  ```sh
  OPENGYM_URL=https://gym.example.com npx -y @redfoxxo/leap pair
  ```

  and enter the code. leap prints a token valid for the instance's session
  lifetime (90 days by default). "Sign out everywhere" in openGym revokes it.

Nothing to download or build: your MCP client starts leap with `npx`, which
fetches [`@redfoxxo/leap`](https://www.npmjs.com/package/@redfoxxo/leap) from
npm on first use. `@1` keeps you on 1.x releases.

### Compatibility

Each leap release works with a range of openGym versions. openGym's API does
not report its version, so leap tells it from what the server answers
(`read_instance` shows it) and refuses to write to a server that is too old.

| leap | openGym |
|---|---|
| 1.1.0 | 1.4.0 or later (tested with 1.4.0) |
| 1.0.0 | 1.3.9 |

Raising the oldest supported openGym is called out in the changelog.
`@redfoxxo/leap@1` runs the newest 1.x release, which needs openGym 1.4.0;
with an older openGym, use `@redfoxxo/leap@1.0.0` until you update it.

## Setup

leap reads its settings from environment variables, which your MCP client
passes to it:

| Variable | Required | Purpose |
|---|---|---|
| `OPENGYM_URL` | yes | Your instance, e.g. `https://gym.example.com` (no `/api/...`). `https` only, except for `localhost` |
| `OPENGYM_TOKEN` | yes | The token from `leap pair`. Never logged |
| `LEAP_TOOLSETS` | no | Tool groups to expose, comma-separated, e.g. `training,exercises,body` (default: all ten). See [Toolsets](#toolsets) |

Keep the token out of config files: export both in your shell profile
(`export OPENGYM_URL=... OPENGYM_TOKEN=...`) and let the client pass them
through, as the examples below do.

### Claude Code

Register the server once for all your projects. `${OPENGYM_URL}` and
`${OPENGYM_TOKEN}` are read from your environment when the server starts:

```sh
claude mcp add-json leap --scope user '{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@redfoxxo/leap@1"],
  "env": {
    "OPENGYM_URL": "${OPENGYM_URL}",
    "OPENGYM_TOKEN": "${OPENGYM_TOKEN}"
  }
}'
```

Then add the four permission rules to `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["mcp__leap__read_*"],
    "ask": ["mcp__leap__write_*", "mcp__leap__delete_*"],
    "deny": ["mcp__leap__admin_*"]
  }
}
```

Claude Code names MCP tools `mcp__<server>__<tool>`, so the server name must be
`leap` for these rules to match. Check the connection with `claude mcp get leap`,
or `/mcp` inside a session.

### opencode

In `~/.config/opencode/opencode.jsonc` (opencode's V2 configuration):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "leap": {
        "type": "local",
        "command": ["npx", "-y", "@redfoxxo/leap@1"],
        "environment": {
          "OPENGYM_URL": "{env:OPENGYM_URL}",
          "OPENGYM_TOKEN": "{env:OPENGYM_TOKEN}",
        },
      },
    },
  },
  "permissions": [
    { "action": "leap_read_*", "resource": "*", "effect": "allow" },
    { "action": "leap_write_*", "resource": "*", "effect": "ask" },
    { "action": "leap_delete_*", "resource": "*", "effect": "ask" },
    { "action": "leap_admin_*", "resource": "*", "effect": "deny" },
  ],
}
```

opencode names MCP tools `<server>_<tool>`, so the server key must be `leap`
for these rules to match (`read_me` becomes `leap_read_me`). `opencode mcp list`
shows whether it connected. leap's tools take up context in every session where
it is connected: expose fewer of them with `LEAP_TOOLSETS` (see
[Toolsets](#toolsets)), or add `"disabled": true` and connect leap from `/mcps`
when you need it.

### Other MCP clients

Any client that starts local (stdio) servers works. Most accept an
`mcpServers` block like this one (Claude Desktop, Cursor, ...):

```json
{
  "mcpServers": {
    "leap": {
      "command": "npx",
      "args": ["-y", "@redfoxxo/leap@1"],
      "env": {
        "OPENGYM_URL": "https://gym.example.com",
        "OPENGYM_TOKEN": "your-token"
      }
    }
  }
}
```

Then map the four tool-name prefixes below to the client's permission system.

## Tools

Every tool name starts with its tier, so one rule per tier covers all tools,
including ones added in later versions. Read tools, and the admin tools that
only read, are also marked read-only in the MCP tool annotations.

| Tier | What it does | Suggested rule |
|---|---|---|
| `read_` | Reads only | allow |
| `write_` | Logs, creates and updates; saves downloads | ask |
| `delete_` | Deletes | ask |
| `admin_` | Instance administration (users, invites, activity log, Coach settings); needs an admin profile | deny |

### Toolsets

74 tools in ten toolsets. The client sends every listed tool to the model on
every request, so expose only the toolsets you use with `LEAP_TOOLSETS`. For
everyday logging (workouts, exercises, body weight)
`LEAP_TOOLSETS=training,exercises,body` gives 20 tools for about 6,600 tokens;
all 74 cost about 17,300. A name that is not a toolset stops leap at startup.

| Toolset | Tools | About |
|---|---|---|
| `training` | 6 | 3,800 tokens |
| `routines` | 13 | 3,900 tokens |
| `body` | 7 | 1,200 tokens |
| `stats` | 4 | 1,000 tokens |
| `exercises` | 7 | 1,600 tokens |
| `settings` | 5 | 1,700 tokens |
| `media` | 5 | 800 tokens |
| `coach` | 6 | 1,100 tokens |
| `account` | 6 | 600 tokens |
| `admin` | 15 | 1,700 tokens |

Measured as the bytes of the tools/list answer divided by four. leap's server
instructions (how the app's sync can undo a change or bring back a deletion,
about 150 tokens) come on top, whatever the toolsets.

**training** (6): the profile overview and logged workouts: `read_profile`,
`read_workouts`, `read_workout`, `write_log_workout`, `write_update_workout`,
`delete_workout`

**routines** (13): routines and the plan: `read_routines`, `read_routine`,
`read_week_plan`, `write_routine`, `write_copy_routine`, `write_week_plan`,
`write_day_plan`, `write_rotation`, `write_schedule_mode`,
`write_rotation_round`, `write_session_queue`, `write_day_note`,
`delete_routine`

**body** (7): body weight, goal and measurements: `read_bodyweight`,
`read_measurements`, `write_bodyweight`, `write_goal_weight`,
`write_measurement`, `delete_bodyweight`, `delete_measurement`

**stats** (4): `read_exercise_history`, `read_records`,
`read_training_summary`, `read_muscle_balance`

**exercises** (7): the catalogue, custom exercises and what you keep per
exercise: `read_exercises`, `read_exercise`, `write_custom_exercise`,
`write_exercise_note`, `write_favourite`, `write_dumbbell_load`,
`delete_custom_exercise`

**settings** (5): `read_settings`, `read_document`, `write_settings`,
`write_dumbbell_rack`, `write_document`

**media** (5): `read_media_usage`, `write_attach_media`,
`write_download_media`, `delete_media`, `delete_media_sweep`

**coach** (6): `read_coach`, `read_coach_cohort`, `write_coach_request`,
`write_coach_resolve`, `write_coach_share`, `delete_coach_data`

**account** (6): `read_me`, `read_instance`, `read_account`,
`write_passkey_name`, `write_pairing_code`, `delete_all_sessions`

**admin** (15): `admin_users`, `admin_user`, `admin_disable_user`,
`admin_delete_user`, `admin_password_reset`, `admin_invites`,
`admin_create_invite`, `admin_revoke_invite`, `admin_audit`,
`admin_clear_audit`, `admin_coach`, `admin_coach_config`, `admin_coach_test`,
`admin_coach_models`, `admin_coach_disconnect`

### Rules leap enforces

- **Network.** leap talks to your instance only, and never follows a redirect.
  openGym's exercise catalogue (5,632 exercises: names, muscles, steps; never
  pictures or animations) ships with leap, taken from the openGym release it
  supports.
- **Writes.** Every write reads the profile, changes only what was asked, and
  is redone on the newer document when another device wrote first; a write
  whose answer was lost is never applied twice. Before every write, leap saves
  a copy of your profile in `~/.local/state/leap/backups/<instance>` (the
  newest 50, readable only by you); no backup, no write. Writes are refused on
  an openGym older than 1.4.0.
- **Uploads.** Photos and videos are read from paths you name, and only if
  their bytes really are JPEG, PNG, WebP, GIF, MP4, MOV or WebM, up to 200 MB.
  Photos lose their metadata (where and when they were taken, the camera)
  before upload, keeping their rotation; videos that record a location are
  refused.
- **Downloads** go to new files only (never overwriting, readable only by
  you), named with the extension of the type their bytes show, never in a
  hidden folder or as a hidden file, and are checked against their hash.
- **Confirmations.** Signing out everywhere, deleting a profile and other
  admin actions that cannot be undone need an explicit confirmation argument;
  sending the Coach's stored provider key to a new endpoint does too.

## Limitations

- Anything that needs your current password as proof is not offered: changing
  the password or sign-in e-mail, removing a passkey, device links. Do these in
  the app, so your password never passes through an AI conversation. For the
  same reason the Coach's provider key is filed in the app.
- Creating passkeys and push notifications: they need a device or browser.
- Changing the weight unit: the app converts every stored weight when you
  switch it.
- Photos and videos are uploaded as they are (not resized). The app makes the
  small previews it shows in lists itself; a file attached through leap shows
  a placeholder there until it is opened.

## Development

Building from source, tests (including live tests against a throwaway openGym
in Docker) and releasing: see [DEVELOPMENT.md](DEVELOPMENT.md).

## License

AGPL-3.0-or-later, like openGym itself (see [LICENSE](LICENSE) and
[NOTICE.md](NOTICE.md)). leap includes openGym's exercise catalogue (text only,
never its pictures or animations) and follows its sync rules. Versions up to
and including 1.0.0 were released under the MIT License.
