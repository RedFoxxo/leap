# leap 🦊

An MCP server for [openGym](https://gitlab.com/DuarteSantos8/opengym): lets AI
assistants log, edit and analyze your workouts, routines, body weight and PRs on
your self-hosted instance, through openGym's own HTTP API.

See [CHANGELOG.md](CHANGELOG.md) for what each version brings.

## Compatibility

Each leap release works with a range of openGym versions. openGym's API does
not report its version, so leap tells it from what the server answers
(`read_instance` shows it) and refuses to write to a server that is too old.

| leap | openGym |
|---|---|
| 1.1.0 (next) | 1.4.0 or later (tested with 1.4.0) |
| 1.0.0 | 1.3.9 |

Raising the oldest supported openGym is called out in the changelog.
`npx -y @redfoxxo/leap@1` runs the newest 1.x release, which needs openGym
1.4.0; with an older openGym, use `@redfoxxo/leap@1.0.0` until you update it.

## Why leap

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

## Configuration

| Variable | Required | Purpose |
|---|---|---|
| `OPENGYM_URL` | yes | Your instance, e.g. `https://gym.example.com` (no `/api/...`) |
| `OPENGYM_TOKEN` | yes | The token from `leap pair`. Never logged |

Keep the token out of config files: export it in your shell profile
(`export OPENGYM_TOKEN=...`) and let the client pass it through.

## Network and files

- leap talks to your instance only. openGym's exercise catalogue (5,632
  exercises: names, muscles, steps; never pictures or animations) ships with
  leap, taken from the openGym release it supports.
- Photos and videos are read from paths you name, and only if they really are
  JPEG, PNG, WebP, GIF, MP4, MOV or WebM. Photos lose their metadata (where and
  when they were taken, the camera) before upload, keeping their rotation;
  videos that record a location are refused. Downloads go to new files only.
- Before every write, leap saves a copy of your profile in
  `~/.local/state/leap/backups/<instance>` (the newest 50, readable only by you).

## opencode

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "leap": {
      "type": "local",
      "command": ["npx", "-y", "@redfoxxo/leap@1"],
      "environment": {
        "OPENGYM_URL": "https://gym.example.com",
        "OPENGYM_TOKEN": "{env:OPENGYM_TOKEN}"
      }
    }
  },
  "permission": {
    "leap_read_*": "allow",
    "leap_write_*": "ask",
    "leap_delete_*": "ask",
    "leap_admin_*": "deny"
  }
}
```

## Permission tiers

| Prefix | What it does | Suggested rule |
|---|---|---|
| `read_` | Reads only | allow |
| `write_` | Logs, creates and updates | ask |
| `delete_` | Deletes | ask |
| `admin_` | Instance administration (users, invites, activity log, Coach settings); needs an admin profile | deny |

## Tools

**read**: `read_profile`, `read_settings`, `read_workouts`, `read_workout`, `read_routines`, `read_routine`,
`read_week_plan`, `read_bodyweight`, `read_measurements`, `read_exercise_history`, `read_records`,
`read_training_summary`, `read_muscle_balance`, `read_exercises`, `read_exercise`,
`read_media_usage`, `read_coach`, `read_coach_cohort`,
`read_account`, `read_me`, `read_instance`, `read_document`

**write**: `write_log_workout`, `write_update_workout`, `write_routine`, `write_copy_routine`, `write_week_plan`,
`write_day_plan`, `write_rotation`, `write_schedule_mode`, `write_rotation_round`, `write_session_queue`,
`write_day_note`, `write_custom_exercise`, `write_bodyweight`, `write_measurement`, `write_goal_weight`,
`write_settings`, `write_exercise_note`, `write_favourite`, `write_dumbbell_rack`, `write_dumbbell_load`,
`write_attach_media`, `write_download_media`, `write_coach_request`,
`write_coach_resolve`, `write_coach_share`, `write_passkey_name`, `write_pairing_code`,
`write_document`

**delete**: `delete_workout`, `delete_routine`, `delete_custom_exercise`,
`delete_bodyweight`, `delete_measurement`, `delete_media`, `delete_media_sweep`, `delete_coach_data`, `delete_all_sessions`

**admin** (admin profiles only): `admin_users`, `admin_user`, `admin_disable_user`,
`admin_delete_user`, `admin_password_reset`, `admin_invites`, `admin_create_invite`,
`admin_revoke_invite`, `admin_audit`, `admin_clear_audit`, `admin_coach`,
`admin_coach_config`, `admin_coach_test`, `admin_coach_models`, `admin_coach_disconnect`

### Not offered, on purpose

- Anything that needs your current password as proof: changing the password
  or sign-in e-mail, removing a passkey, device links. Do these in the app,
  so your password never passes through an AI conversation. For the same
  reason the Coach's provider key is filed in the app.
- Creating passkeys and push notifications: they need a device or browser.
- Changing the weight unit: the app converts every stored weight when you
  switch it.

## License

AGPL-3.0-or-later, like openGym itself (see [LICENSE](LICENSE) and
[NOTICE.md](NOTICE.md)). leap includes openGym's exercise catalogue (text only,
never its pictures or animations) and follows its sync rules. Versions up to
and including 1.0.0 were released under the MIT License.
