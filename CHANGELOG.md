# Changelog

User-facing changes, newest first. Sudo-chan is an early prototype, so expect rough edges.
The release workflow copies the section whose heading matches the tag version into the GitHub release notes.

## [0.1.0] - Unreleased

First public prototype: the desktop companion for Linux, plus the website with a waitlist.

### Desktop companion
- A small animated bot that lives on your desktop: draggable, with optional cute glasses, a chat window, a Pomodoro focus timer and a laptop health (RAM) alert.
- Chats in English and Pakistani Roman Urdu, matching the language you use. Works with your own cloud AI key (Groq or Google Gemini).
- Replies are direct and use real facts about the app instead of canned "tell me more" answers (a 42-prompt check went from 21% to 93% passing).

### Voice
- Say "Sudo" or "Sid" and the desktop bot wakes up and talks with you, without opening the chat window. Listening for her name is on by default; turn it off in Settings, with the status dot on the bot, or from the tray menu.
- A caption above the bot shows what she answers. A glow around the bot shows that she hears you.
- You can interrupt her mid-sentence. If she cannot understand the interruption she continues where she stopped; "stop", "ruko" or "bas" keeps her quiet.
- Speech recognition: Fast (Whisper first) or Accurate (Gemini first), chosen in Settings.
- Voice output: Google voice by default, with optional Gemini or Azure Speech voices if you add a key. Gemini's free quota is small.
- Only the bot you are talking to moves its mouth.

### Installing and updates
- Linux packages: an AppImage and a `.deb`, with a `SHA256SUMS` file so you can check your download. Windows and macOS packages are configured but have not been built or tested yet.
- Settings tells you, in one calm line, if a newer version exists. The check happens at most once a day, only asks GitHub for the public release list, never downloads or installs anything, and can be switched off in Settings ("Check for new versions").
- The system tray now shows the Sudo-chan icon.

### Privacy and safety
- Your API keys stay on your computer and are never sent to the website.
- Audio is not saved to disk. The only exception is a voice sample you choose to register for voice lock; it stays on your computer.

### Website
- Landing page, waitlist, privacy policy and a Download page.

### Known limitations
- Early prototype; Linux first. Windows and macOS builds are not available yet.
- Builds are unsigned, so Windows SmartScreen and macOS Gatekeeper will warn once those builds exist.
- Urdu and Roman Urdu recognition is still unreliable; a good share of short clips may not be understood.
- The default voice is robotic. A natural voice needs a Gemini or Azure key.
- API keys are stored on your computer but not strongly encrypted yet.
- Features that act on your computer (files, commands) or look at your screen are off by default and ask before they act. They have only been tested by their developers.
- The AppImage may need `--no-sandbox` on systems that restrict unprivileged user namespaces (for example Ubuntu 24.04). The `.deb` does not.
