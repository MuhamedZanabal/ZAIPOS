!macro customInstall
  DetailPrint "Provisioning ZAIPOS local runtime..."
  nsExec::ExecToLog 'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\runtime\install-local-service.ps1" -Role "server+terminal" -DataRoot "C:\ProgramData\ZAIPOS" -ServiceBinary "$INSTDIR\resources\runtime\zaipos-local-service.exe"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "ZAIPOS Local Service provisioning failed with exit code $0."
    Abort
  ${EndIf}
!macroend

!macro customUnInstall
  DetailPrint "Stopping ZAIPOS local runtime (business data will be preserved)..."
  nsExec::ExecToLog 'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\runtime\uninstall-local-service.ps1" -DataRoot "C:\ProgramData\ZAIPOS" -PreserveData $$true'
  Pop $0
  ${If} $0 != 0
    DetailPrint "ZAIPOS Local Service cleanup returned $0; preserving data and continuing uninstall."
  ${EndIf}
!macroend
