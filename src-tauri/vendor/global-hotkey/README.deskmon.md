# Deskmon dependency backport

Base: crates.io `global-hotkey 0.8.0`, unmodified published sources except the two
macOS files described below. Original MIT and Apache 2.0 licenses are retained.

Tauri's `tauri-plugin-global-shortcut 2.4.1` requires `global-hotkey ^0.8`.
The macOS exclusivity fix is released upstream in 0.10, outside that constraint.
Deskmon uses this path dependency through `[patch.crates-io]` until the Tauri
plugin supports an upstream version containing the fix.

## Patch

Backported from official upstream commit
[`c0fb67af3349770d81e1a50a514056e31cee3f64`](https://github.com/tauri-apps/global-hotkey/commit/c0fb67af3349770d81e1a50a514056e31cee3f64)
(`fix(macos): register hotkeys exclusively (#229)`):

- `src/platform_impl/macos/ffi.rs`: declare `kEventHotKeyExclusive` and `eventHotKeyExistsErr`.
- `src/platform_impl/macos/mod.rs`: use exclusive registration, map the occupied-key
  result to `AlreadyRegistered`, and include OSStatus in other registration errors.

No event delivery, key mapping, Windows, Linux, or public API changes are included.
The upstream examples and package metadata are retained for provenance; Deskmon
does not compile or ship the example applications.

## Verification

Use two independent processes, both registering the same test combination through
this crate's public `GlobalHotKeyManager`. The first process holds it; the second
must return `Error::AlreadyRegistered`. Before the patch, the second registration
succeeds silently. No key synthesis or user clipboard contents are required.

On a future plugin upgrade, check its actual resolved dependency, rerun the native
two-process check, and remove this patch when the upstream version passes it.
