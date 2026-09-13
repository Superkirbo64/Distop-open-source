; Desinstalar Distop sin dejar basura. electron-builder lo incluye solo
; (nsis.include apunta por defecto a build/installer.nsh).
;
; Se borra todo el perfil de la app MENOS `instance`: ahí viven las comunidades
; que hospeda este PC y sus copias, y reinstalar no debe costarlas.
; Nada corre en una actualización: el actualizador desinstala la versión vieja
; antes de poner la nueva, y borrar ahí cerraría la sesión en cada versión.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    FindFirst $0 $1 "$APPDATA\Distop\*"
    ${DoWhile} $1 != ""
      ${If} $1 != "."
      ${AndIf} $1 != ".."
      ${AndIf} $1 != "instance"
        ; Una de las dos no hace nada: RMDir no borra ficheros ni Delete carpetas.
        RMDir /r "$APPDATA\Distop\$1"
        Delete "$APPDATA\Distop\$1"
      ${EndIf}
      FindNext $0 $1
    ${Loop}
    FindClose $0
    ; Restos de versiones anteriores: el actualizador viejo y el cascarón Tauri.
    RMDir /r "$LOCALAPPDATA\@distopdesktop-updater"
    RMDir /r "$APPDATA\com.distop.tauri"
    RMDir /r "$LOCALAPPDATA\com.distop.tauri"
  ${endIf}
!macroend
