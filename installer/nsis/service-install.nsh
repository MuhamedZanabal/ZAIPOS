; Restricted local service. The binary never receives database credentials on the command line.
!macro ZAIPOS_INSTALL_SERVICE
  nsExec::ExecToLog 'sc.exe create ZAIPOSLocalService binPath= "$INSTDIR\resources\zaipos-local-service.exe" start= auto DisplayName= "ZAIPOS Local Service"'
  nsExec::ExecToLog 'sc.exe failure ZAIPOSLocalService reset= 60 actions= restart/5000'
  nsExec::ExecToLog 'sc.exe start ZAIPOSLocalService'
!macroend
