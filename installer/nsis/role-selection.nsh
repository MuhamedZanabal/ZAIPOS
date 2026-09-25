; ZAIPOS role page. The packaged installer offers exactly two roles.
; Server + terminal installs PostgreSQL and ZAIPOSLocalService.
; Terminal only enrolls against an existing store and installs neither.

!macro ZAIPOS_ROLE_PAGE
  !insertmacro MUI_HEADER_TEXT "ZAIPOS role" "Choose how this computer participates."
  ; Server + terminal
  ; Terminal only
!macroend
