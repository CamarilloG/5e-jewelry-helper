; 饰品驿站助手 NSIS 自定义钩子（技术选型 §2）
; 真正卸载时清除本应用的 URI scheme、Toast Activator CLSID 与 AUMID 注册；删除前校验注册项目标属于本次安装目录，
; 被其他程序接管的关联不删除。覆盖升级（${isUpdated}）不执行这段清理。业务数据默认保留，另提供明确的清除选项。

!define JH_SCHEME "jewelry-helper"
!define JH_CLSID "{3D5F7673-DF85-49BB-BDE9-563EA5F5BEBD}"
!define JH_AUMID "io.github.camarillog.jewelryhelper"
!define JH_EXE "JewelryHelper.exe"

; $R1 = 被查找文本，$R2 = 子串；返回 $R0 = 1 / 0（不区分大小写）
!macro JH_CONTAINS_FN PREFIX
Function ${PREFIX}JHContains
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  StrCpy $R0 0
  StrCpy $R5 0
  StrLen $R3 $R2
  StrLen $R4 $R1
  IntCmp $R3 0 jh_done 0 0
  IntOp $R4 $R4 - $R3
  jh_loop:
    IntCmp $R5 $R4 0 0 jh_done
    StrCpy $R6 $R1 $R3 $R5
    StrCmp $R6 $R2 0 jh_next
      StrCpy $R0 1
      Goto jh_done
    jh_next:
    IntOp $R5 $R5 + 1
    Goto jh_loop
  jh_done:
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
FunctionEnd
!macroend

!ifdef BUILD_UNINSTALLER
  !insertmacro JH_CONTAINS_FN "un."
!endif

!macro customInstall
  ; 安装/覆盖升级完成后确保协议指向本次安装目录（应用运行时也会再次确认）
  WriteRegStr HKCU "Software\Classes\${JH_SCHEME}" "" "URL:饰品驿站助手通知"
  WriteRegStr HKCU "Software\Classes\${JH_SCHEME}" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\${JH_SCHEME}\DefaultIcon" "" "$INSTDIR\${JH_EXE},0"
  WriteRegStr HKCU "Software\Classes\${JH_SCHEME}\shell\open\command" "" '"$INSTDIR\${JH_EXE}" "%1"'
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; ---- URI scheme ----
    ReadRegStr $R1 HKCU "Software\Classes\${JH_SCHEME}\shell\open\command" ""
    StrCpy $R2 "$INSTDIR\${JH_EXE}"
    Call un.JHContains
    ${If} $R0 == 1
      DeleteRegKey HKCU "Software\Classes\${JH_SCHEME}"
    ${EndIf}
    ; ---- Toast Activator CLSID ----
    ReadRegStr $R1 HKCU "Software\Classes\CLSID\${JH_CLSID}\LocalServer32" ""
    StrCpy $R2 "$INSTDIR\${JH_EXE}"
    Call un.JHContains
    ${If} $R0 == 1
      DeleteRegKey HKCU "Software\Classes\CLSID\${JH_CLSID}"
    ${EndIf}
    ; ---- AUMID：图标指向本安装目录，或激活器为本应用 CLSID 时才删除 ----
    ReadRegStr $R1 HKCU "Software\Classes\AppUserModelId\${JH_AUMID}" "IconUri"
    ReadRegStr $R3 HKCU "Software\Classes\AppUserModelId\${JH_AUMID}" "CustomActivator"
    StrCpy $R2 "$INSTDIR"
    Call un.JHContains
    ${If} $R0 == 1
    ${OrIf} $R3 == "${JH_CLSID}"
      DeleteRegKey HKCU "Software\Classes\AppUserModelId\${JH_AUMID}"
    ${EndIf}
    ; ---- 缓存与日志随卸载删除；业务数据默认保留 ----
    RMDir /r "$LOCALAPPDATA\JewelryHelper\cache"
    RMDir /r "$LOCALAPPDATA\JewelryHelper\electron"
    RMDir /r "$LOCALAPPDATA\JewelryHelper\logs"
    ${IfNot} ${Silent}
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "是否同时删除本机业务数据？$\r$\n（收藏、下单预设、常用方案和订单恢复记录，删除后不可恢复）$\r$\n$\r$\n选择“否”将保留数据，重新安装后可继续使用。" IDNO jh_keep_data
        RMDir /r "$LOCALAPPDATA\JewelryHelper"
      jh_keep_data:
    ${EndIf}
  ${endIf}
!macroend
