# Virtual Display Driver — redistributed, unmodified

`MttVDD.dll`, `MttVDD.inf` and `mttvdd.cat` in this folder are the **signed
release files of the open-source Virtual Display Driver**, copied byte for
byte. Púca does not build or change them. They are what lets a Windows laptop
be remote-controlled with its lid closed: with no screen switched on, Windows
has nothing to capture, so the remote-access service switches this virtual
screen on for the length of a remote session and off again afterwards
(`crates/puca-service/src/virtual_screen.rs`, `docs/REMOTE_CONTROL.md`).

- Project: https://github.com/VirtualDrivers/Virtual-Display-Driver, by
  MikeTheTech and contributors, built on Microsoft's Indirect Display (IddCx)
  driver sample.
- Licence: MIT. The full text is in `LICENSE` beside this file.
- Release: `24.12.24` (tag commit `b07c8cc80c95042a8b5a1a97e67c8e4a51ab8c10`),
  asset `Signed-Driver-v24.12.24-x64.zip`. The newest release, `25.7.23`, ships
  the same three files byte for byte in `VirtualDisplayDriver-x86.Driver.Only.zip`.
  Despite the "x86" in that name, the INF targets `NTamd64`. There is no x86
  build and none is needed: Púca's Windows build is x64 only.
- INF: `DriverVer = 12/24/2024,11.30.4.434`, hardware ID `Root\MttVDD`, class
  `Display`, a UMDF driver using IddCx 1.2 (Windows 10 1903 or later).
- Signature: the catalog and the DLL carry a valid Authenticode signature from
  `CN=SignPath Foundation` (issued by GlobalSign GCC R45 CodeSigning CA 2020,
  chaining to GlobalSign Code Signing Root R45, timestamped by DigiCert). The
  driver is NOT signed by Microsoft (neither WHQL nor attestation), so Windows
  shows its own "Would you like to install this device software?" prompt
  naming the publisher. Púca deliberately does **not** add the SignPath
  certificate to the machine's Trusted Publishers to skip that prompt: that
  certificate signs many unrelated open-source projects, and trusting it
  machine-wide would silently extend to all of them.

SHA-256, checked by the service before it installs anything (the same values
are pinned in `virtual_screen.rs`):

```
c9ca837f57a98fbd43bc416a7f535a95843626e7759eaf85cf0cd7ce334dbb05  MttVDD.dll
550d211fe481e74dfe3f9d724ed78be48b3a9113405965d683d9373e8d672f5d  MttVDD.inf
08a0093fc9b2e32b287a6f8a77ca4de0a31830d29fc33d2b13a918dc859468f6  mttvdd.cat
```

The release's own `vdd_settings.xml` is not shipped. Púca writes its own: one
screen at 1920x1080, 60 Hz, logging off.

**Known property of this driver, recorded so it is not rediscovered.** While
the device is running it serves a control pipe,
`\\.\pipe\MTTVirtualDisplayPipe`, whose security descriptor is
`D:(A;;GA;;;WD)`: any local process may connect. Its commands reload the
driver, change the number of virtual screens, choose the GPU and toggle
options. Púca limits that exposure in two ways. The device is **disabled
except during a remote session**, so the pipe does not exist the rest of the
time. And the driver's settings folder is one that only administrators can
write, so nothing sent over the pipe can persist into the next session.
