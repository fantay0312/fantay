# TokenToSea account footer

The sidebar used to render the TokenToSea account as a generic footer notice,
then append a separate legacy local-mode identity row. Those rows described
different identity systems and used different widths, so a signed-in user saw
both `fantay` and `本地模式` with inconsistent alignment.

The product shell now passes the TokenToSea control through an explicit
`accountSlot`. That slot replaces the legacy identity row and shares one row
with the notification bell. The user name is left-aligned, truncates safely,
and carries a `TokenToSea 已登录` subtitle. Creation files remaining on this
device is explained inside the account menu rather than presented as a second
identity.

The account menu opens above the dock and provides share management, settings
and sign-out. It supports keyboard navigation, Escape and outside dismissal.
The notification dialog retains its opener and focus return. Authorization
waiting has a separate cancel/reopen surface and does not expose client setup
fields when the app is already configured.

Focused component tests cover both absent and present legacy workspaces,
single-account rendering, notifications, settings, sign-out and pending
authorization. Type checking and style checks pass. No Chrome control,
Computer Use or screen capture was used for this correction; visual evidence
for the original defect was the user's supplied screenshot.

The updated Mac package was installed and started using the existing namespace
and data root. The `fantay` login was preserved. Eighteen focused component
checks, Web type checking and repository guards passed. The installed main
bundle contains the new single-account dock.

Package: `.tmp/desktop/Fantaydesign.dmg`, 432282924 bytes, SHA-256
`1b92e7fd0d89e83d925ad50e3be675dfea2676c09b64b4f7afe979d320774e37`.
