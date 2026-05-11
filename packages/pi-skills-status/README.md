# @season179/pi-skills-status

Show the skills used in the current Pi session.

The extension adds a compact `skills:` footer item to Pi after a skill is used. It updates when you invoke a skill explicitly or when Pi reads a loaded `SKILL.md` file, so you can see which skill context is active without digging through the transcript.

## What It Does

- Tracks explicit `/skill:name` invocations.
- Tracks loaded skill files read by Pi during the session.
- Shows up to three recent skills in Pi's status area.
- Adds a `/skills-status` command that reports all tracked skills.

This is best-effort session visibility, not a full audit log. It tracks skill blocks and `SKILL.md` reads that Pi exposes through extension events. If Pi changes how skills are loaded, or if skill context enters the session without those events, it may not appear in the footer.

## Installation

```bash
pi install npm:@season179/pi-skills-status
```

## Usage

Start Pi normally. The status area stays quiet until a skill is detected.

After skills are used, it shows something like:

```txt
skills: code-reviewer, simplify
```

You can also run:

```txt
/skills-status
```

inside Pi to show the skills used in the current session.

## Included Resources

- Pi extension: `dist/extensions/skills-status.js`

## Local Development

```bash
npm install
npm run build --workspace @season179/pi-skills-status
```

Test without publishing:

```bash
pi -e ./packages/pi-skills-status
```

Smoke-test package loading without your global extensions:

```bash
pi --no-extensions -e ./packages/pi-skills-status --help
```

Because this package publishes compiled JavaScript, build before using `pi -e` from the package directory.

## Tarball Validation

```bash
npm pack --workspace @season179/pi-skills-status
tar -tf season179-pi-skills-status-26.5.0.tgz
pi install ./season179-pi-skills-status-26.5.0.tgz
```

The tarball should include:

```txt
package/package.json
package/README.md
package/LICENSE
package/dist/extensions/skills-status.js
```

## Publishing

```bash
npm login
npm publish --access public
```

Scoped public packages require `--access public`.

## Compatibility

Tested with:

- Pi: 0.74.0
- Node.js: >=22

## Security

Pi extensions execute with your user permissions. This extension observes Pi session events and tool results to infer skill usage, but it does not modify files or run shell commands. Review the source before installing.

## Troubleshooting

- If the status never appears after using a skill, make sure the extension is installed and Pi has loaded it.
- If package resources are not found during local testing, build the package first.
- If the command is unavailable, reinstall the package with `pi install npm:@season179/pi-skills-status`.
