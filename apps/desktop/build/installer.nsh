; Custom NSIS hooks for the Nekko Agent installer/uninstaller.
;
; On uninstall, offer to also remove the user's data: the data folder
; (%USERPROFILE%\.nekko-agent: chats, settings, sign-ins, logs, downloaded
; models), the older profile folder (%APPDATA%\Nekko Agent), and the keys the
; app saved in Windows Credential Manager (every generic credential whose
; target holds "dev.nekkolabs.nekko-agent."). `/SD IDNO` makes silent
; uninstalls, including the one electron-updater runs during an auto-update,
; default to "No", so updates never wipe a user's data.

!macro customUnInstall
  MessageBox MB_YESNO|MB_ICONQUESTION "Also delete your Nekko Agent chats, settings, sign-ins, saved keys and downloaded models?$\n$\nChoose No to keep them for a future reinstall." /SD IDNO IDYES NekkoDeleteData
    Goto NekkoKeepData
  NekkoDeleteData:
    ; cmdkey /list prints "Target: LegacyGeneric:target=<name>"; delete each of ours by name.
    nsExec::Exec `"$SYSDIR\cmd.exe" /d /c for /f "tokens=1,* delims==" %a in ('"$SYSDIR\cmdkey.exe" /list ^| "$SYSDIR\findstr.exe" /c:"dev.nekkolabs.nekko-agent."') do @"$SYSDIR\cmdkey.exe" /delete:%b`
    Pop $0
    RMDir /r "$PROFILE\.nekko-agent"
    RMDir /r "$APPDATA\Nekko Agent"
  NekkoKeepData:
!macroend
