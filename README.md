# Projects Plugin

A powerful Project Management sidebar extension for VS Code / Antigravity IDE.

## Features

- **Project Management**: Add and manage multiple projects from the sidebar.
- **Dynamic Skills**:
  - Automatically scans `.agent/skills` recursively.
  - Displays skill structure with **Japan Theme** styling (Tsuyukusa-iro 🔵).
  - Supports live updates (FileSystemWatcher).
- **Live Chats**:
  - Groups conversations by project context.
  - Auto-updates every 30 seconds.
  - Visual indicators (Japanese Red 🔴).
- **Seamless Refresh**:
  - Persists folder expansion state across reloads.
  - "Green Dot" project indicators (Moegi 🟢).

## Installation

1. `npm install`
2. `npm run compile`
3. Press `F5` to debug.

## Usage

1. Click the "+" icon to add a project folder.
2. View detected Skills and Conversations associated with that project.
3. Click "Details" in the footer to view usage quotas.

## Colors

- **Projects**: Japanese Green (#006E54)
- **Chats**: Japanese Red (#CB4042)
- **Skills**: Japanese Blue (#2EA9DF)
