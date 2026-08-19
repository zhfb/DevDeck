---
version: alpha
name: DevDeck
description: macOS-native developer workbench — SSH/SFTP/Docker/Tunnel console. Precise, restrained, information-dense. Dark-first with macOS system-blue accent.
colors:
  primary: "#0A84FF"
  primary-hover: "#3A9BFF"
  accent: "#0A84FF"
  neutral: "#E8EAED"
  bg-canvas: "#0B0D0F"
  bg-panel: "#101316"
  bg-surface: "#16191D"
  bg-elevated: "#1C2126"
  text-primary: "#E8EAED"
  text-secondary: "#B0B6BF"
  text-tertiary: "#7C838D"
  text-quaternary: "#565C66"
  border-subtle: "rgba(255,255,255,0.06)"
  border-standard: "rgba(255,255,255,0.10)"
  success: "#30D158"
  warning: "#FFD60A"
  danger: "#FF453A"
  env-dev: "#30D158"
  env-staging: "#FFD60A"
  env-prod: "#FF453A"
typography:
  display:
    fontFamily: -apple-system
    fontSize: 1.75rem
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  heading:
    fontFamily: -apple-system
    fontSize: 1.125rem
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  body:
    fontFamily: -apple-system
    fontSize: 0.875rem
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0em"
  body-medium:
    fontFamily: -apple-system
    fontSize: 0.875rem
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: "0em"
  small:
    fontFamily: -apple-system
    fontSize: 0.8125rem
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "0em"
  caption:
    fontFamily: -apple-system
    fontSize: 0.75rem
    fontWeight: 500
    lineHeight: 1.35
    letterSpacing: "0em"
  label:
    fontFamily: -apple-system
    fontSize: 0.6875rem
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.04em"
  mono:
    fontFamily: ui-monospace, SFMono-Regular, Menlo
    fontSize: 0.8125rem
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "0em"
  mono-caption:
    fontFamily: ui-monospace, SFMono-Regular, Menlo
    fontSize: 0.75rem
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "0em"
rounded:
  sm: 4px
  md: 6px
  lg: 8px
  xl: 12px
  full: 9999px
spacing:
  xxs: 2px
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  xxl: 32px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#FFFFFF"
    rounded: "{rounded.md}"
    padding: 6px 12px
  button-secondary:
    backgroundColor: "rgba(255,255,255,0.06)"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.md}"
    padding: 6px 12px
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.md}"
    padding: 5px 10px
  input:
    backgroundColor: "rgba(255,255,255,0.04)"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.md}"
    padding: 6px 10px
  card:
    backgroundColor: "{colors.bg-surface}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    padding: 16px
  badge-neutral:
    backgroundColor: "rgba(255,255,255,0.06)"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.full}"
    padding: 2px 8px
  badge-running:
    backgroundColor: "rgba(48,209,88,0.12)"
    textColor: "{colors.success}"
    rounded: "{rounded.full}"
    padding: 2px 8px
  badge-paused:
    backgroundColor: "rgba(255,214,10,0.12)"
    textColor: "{colors.warning}"
    rounded: "{rounded.full}"
    padding: 2px 8px
  badge-stopped:
    backgroundColor: "rgba(255,255,255,0.06)"
    textColor: "{colors.text-tertiary}"
    rounded: "{rounded.full}"
    padding: 2px 8px
  badge-danger:
    backgroundColor: "rgba(255,69,58,0.12)"
    textColor: "{colors.danger}"
    rounded: "{rounded.full}"
    padding: 2px 8px
  sidebar-item:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.md}"
    padding: 4px 8px
  sidebar-item-active:
    backgroundColor: "rgba(255,255,255,0.08)"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.md}"
    padding: 4px 8px
---

# DevDeck Design System

## Overview

DevDeck is a macOS-native developer workbench: SSH terminals, SFTP file management, Docker container control, and port tunnels — an information-dense operations console. The design language is **macOS-native restraint**: dark-first, precision-dense, with luminance-graded surfaces (the Linear model) and a single system-blue accent (macOS `#0A84FF`). No decorative gradients, no glassmorphism, no marketing framing. The UI earns hierarchy through type scale, spacing, and surface luminance steps — not through boxes, icons, or color.

The dominant surface archetype is **Operate** (taking action on containers/hosts/tunnels) with **Monitor** moments (stats, logs, events). Composition favors dense tables, glanceable status, and keyboard-first interaction (Cmd+K command palette, tab-driven workspace).

## Colors

### Dark (native, default)
- **Canvas `#0B0D0F`** — deepest background, slight blue-cool undertone. App window chrome, workspace canvas.
- **Panel `#101316`** — sidebar/resource-tree background, one step above canvas.
- **Surface `#16191D`** — cards, list items, inputs, dropdowns.
- **Elevated `#1C2126`** — popovers, dialogs, command palette.
- **Text ladder** — Primary `#E8EAED` (near-white, not pure white), Secondary `#B0B6BF`, Tertiary `#7C838D` (metadata, placeholders), Quaternary `#565C66` (timestamps, disabled).
- **Accent `#0A84FF`** — macOS system blue; the ONLY chromatic chrome color. Reserved for active states, primary CTAs, selection, focus.
- **Semantic** — Success `#30D158`, Warning `#FFD60A`, Danger `#FF453A` (macOS system palette). Used ONLY for status signals (container state dots, health badges, destructive actions).
- **Environment color cards** — Dev `#30D158`, Staging `#FFD60A`, Prod `#FF453A`. Small tinted labels on host entries.
- **Borders** — Subtle `rgba(255,255,255,0.06)`, Standard `rgba(255,255,255,0.10)`. Borders are whisper-thin; elevation is communicated by surface luminance, not shadows.

### Light (secondary, toggleable)
Canvas `#F5F6F7`, Panel `#EBEDEF`, Surface `#FFFFFF`, Border `#E0E3E6`, text ladder inverted with same roles, accent `#007AFF`.

## Typography

System SF Pro (`-apple-system`) everywhere — this is a native macOS app, no webfonts, no Inter. SF Mono (`ui-monospace, SFMono-Regular, Menlo`) for all technical content: container IDs, image refs, addresses, logs, stats.

- **Weights**: 400 (reading), 500 (emphasis), 600 (headings/labels). No 700+. The system feels native because weight usage matches macOS conventions.
- **Display 28px / -0.02em / 600** — page headers only (Dashboard title, detail pages). Never decorative stats.
- **Label 11px / 600 / +0.04em uppercase** — section headers in sidebar, column group labels, category labels (macOS convention).
- Mono everywhere technical: IDs truncated with ellipsis, addresses in `user@host:port` form.

## Layout

- **Spacing scale**: 4/8/12/16/24/32. Density is tight — this is an operations console, not a marketing site. Table rows 28–32px, sidebar items 24–28px.
- **Chrome**: 44px nav rail (top), collapsible 240px resource tree (left), tab canvas (center), 180px dockable bottom panel (logs/events/tasks). Panels can float/dock; layout persisted.
- **Breakpoints**: the app is a desktop-only utility (macOS); min window 960×640, no mobile behavior.

## Elevation & Depth

Luminance stepping is the only elevation language:
- Level 0 Canvas → Level 1 Panel → Level 2 Surface → Level 3 Elevated (each +3–5 luminance points)
- Borders at 6–10% white opacity define containment
- Shadows only for floating chrome: command palette, dialogs, context menus (`rgba(0,0,0,0.5)` 0 8px 24px)
- No inset shadows, no glow, no blur (vibrancy excluded by design for consistency)

## Shapes

- 4px micro (status dots, inline tags), 6px standard controls (buttons, inputs, sidebar items), 8px cards/tables, 12px dialogs/palette, full pill for status badges.
- Status dots: 6px circles with state color, ring `rgba(255,255,255,0.12)` for contrast on dark.

## Components

### Status Badge (container states)
`badge-running` green tint / `badge-paused` yellow tint / `badge-stopped` neutral / `badge-danger` red tint. Text 11px 500 with 6px leading state dot. Tint backgrounds at 12% color opacity — color carries meaning, text stays legible.

### Sidebar / Resource Tree
- 13px secondary text, active item = `rgba(255,255,255,0.08)` fill + primary text, group headers = 11px uppercase tertiary.
- Engine badges (OrbStack / Docker Desktop / Colima / Podman / SSH:host) as 11px mono tags.
- Environment tags on hosts: 2px-wide color rail + 11px label in env color.

### Table (container/host/image lists)
- Header: 11px uppercase tertiary, 28px row height.
- Rows: 13px, hover `rgba(255,255,255,0.04)`, selected `rgba(10,132,255,0.12)` + 2px accent left rail.
- Columns: name/ID (mono, truncated), image (mono), status (badge), ports, CPU/MEM (mono right-aligned), uptime (mono).
- Row actions: ghost icon buttons appear on hover.

### Buttons
- Primary: solid `#0A84FF`, white text — one per view (Connect, Pull, Start).
- Secondary: 6% white fill, standard border — toolbar actions.
- Ghost: transparent, secondary text — row/context actions. Icon-only variants 28px square.

### Terminal (xterm)
- Canvas `#0B0D0F`, text `#E8EAED`, cursor `#0A84FF` block. Selection `rgba(10,132,255,0.25)`.
- Tab strip 32px, active tab = elevated surface + primary text; dirty/activity dot.
- Scrollback 10k lines, WebGL renderer, fit addon.

## Do's and Don'ts

### Do
- Use luminance steps (Canvas→Panel→Surface→Elevated) for hierarchy; borders only as containment.
- Reserve `#0A84FF` for interaction: active, selected, focus, primary action.
- Use semantic colors strictly for status signals — never decoration.
- Truncate long IDs/addresses with ellipsis, keep mono font.
- Keep rows dense: 28–32px. This is a power-user console.
- Keyboard-first: Cmd+K, Tab navigation, Enter to connect, Esc to dismiss.
- Confirm destructive actions (delete container/image, clear logs) with a dialog before executing.

### Don't
- No gradients, no glow, no glassmorphism, no colorful icons — chrome is monochrome + system blue.
- No pure white text on dark — `#E8EAED` prevents harsh contrast.
- No Inter/Google fonts — SF Pro is the native voice.
- No marketing framing: no hero, no feature cards with icons, no decorative stats.
- No fake dashboard numbers — every metric shown must come from a real source (bollard, SSH sampling, events).
- Don't center content — density and alignment to the grid.
- Don't hide destructive actions behind hover-only affordances in critical rows.
