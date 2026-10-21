; dsh-pet 安装包的自定义 NSIS 片段（electron-builder 的 nsis.include）。
;
; 开机自启（ticket 09）的写入有两条路径，格式必须逐字一致：
;   1. 安装完成时（本文件的 customInstall）：spec 要求「默认开启，安装完成后即生效」。
;      若用户安装时取消「立即运行」，也要在重启后自启 —— 不能等到首次手动启动才写。
;   2. 应用首次启动时（desktop/main.mjs → src/host/autostart.ts）作为兜底：
;      安装器没写成功（如注册表被策略拦截）或非安装版形态时补写。
; 写入 HKCU\Software\Microsoft\Windows\CurrentVersion\Run：
;   值名 `electron.app.DSH Pet`（Electron 43 的默认命名，与 setLoginItemSettings 一致）；
;   值数据 `"<安装目录>\DSH Pet.exe" --autostart`（与 Electron 写入格式一致）。
; electron-builder 不知道这个值，卸载时必须自己清理，否则卸载后应用仍会随登录启动。
;
; 安装/卸载的两个约束：
;   1. 安装侧按当前产品名写入 `electron.app.DSH Pet`（Electron 43 实测的默认命名）；
;      卸载侧不能写死值名（Electron 生成的名称随应用名/版本可能变化），而是按
;      「值数据 = 当前安装目录下的 exe + --autostart」匹配，既不漏删也不误伤其它软件。
;   2. 任务管理器的「禁用」状态另存在 StartupApproved\Run 的同名值里，一并清理。
;
; 升级安装会先运行旧版卸载器（isUpdated=true）：此时绝不能删除启动项，否则升级后
; 开机自启静默丢失（初始化标记还在，应用不会再次自动开启）。
;
; 已知边界：安装段（customInstall）仍只认默认数据目录 `$PROFILE\.dsh\dsh-pet`，
; 用户自定义 DSH_HOME 时读不到应用的标记 —— 由 ticket 03 统一到下面的 dshPetDataDir 宏。
; 卸载段（customUnInstall）已改用该宏，两侧路径算法将来只需维护一处。

!include LogicLib.nsh
!include FileFunc.nsh
!include nsDialogs.nsh
!include MUI2.nsh

; ---------------------------------------------------------------------------
; 用户数据目录（<DSH_HOME>）：安装器里所有「用户数据」路径的唯一算法。
;
; 口径与 src/host/storage-paths.ts / scripts/dist.mjs 一致：读环境变量 DSH_HOME，
; 未设置（或为空）时回落到 $PROFILE\.dsh。注意安装器只能看到**执行安装那一刻**
; 的环境变量，用户之后才改 DSH_HOME 的情况不在支持范围内。
;
; 用法：!insertmacro dshPetDataDir $0   → 结果在 $0（调用方负责保护寄存器）。
; 这是给后续 ticket 复用的接缝：换实现（缓存、校验、注册表兜底）只改这里。
; ---------------------------------------------------------------------------
!macro dshPetDataDir OUT
  ReadEnvStr ${OUT} "DSH_HOME"
  ${If} ${OUT} == ""
    StrCpy ${OUT} "$PROFILE\.dsh"
  ${EndIf}
!macroend

; ---------------------------------------------------------------------------
; 卸载勾选页：删程序之前先问「用户数据要不要一起删」。
;
; 为什么不用 electron-builder 的 customUninstallPage：那个宏插在
; MUI_UNPAGE_INSTFILES **之后**（文件已经删完了），问了也来不及。
; assistedInstaller.nsh 的卸载分支里，欢迎页由 `!ifndef removeDefaultUninstallWelcomePage`
; 控制 —— 定义它让出位置，页面顺序变成「本页 → 进度页 → 完成页」，缺的欢迎页职责
; （说明这次卸载会做什么）并入本页文案。
;
; 四个勾选项默认全不勾：不勾 = 一个字节都不碰，卸载只是「卸掉程序」。
; 用户勾了什么，就通过 $dshPetPurge* 这组全局变量传给卸载段；页面取消/关闭 → Abort。
; ---------------------------------------------------------------------------

; 勾选结果（供 un.customUnInstall 读取；卸载器与 installer 是两次独立编译，变量按次声明）
!ifdef BUILD_UNINSTALLER
  Var dshPetHome
  Var dshPetPurgeData
  Var dshPetPurgeAi
  Var dshPetPurgeRuntime
  Var dshPetPurgeCache

  Var dshPetPageCheckData
  Var dshPetPageCheckAi
  Var dshPetPageCheckRuntime
  Var dshPetPageCheckCache

  ; 卸载器不显示默认欢迎页，腾出「欢迎页 → 进度页」之间的位置给勾选页
  !define removeDefaultUninstallWelcomePage

  !insertmacro MUI_UNPAGE_INIT
  UninstPage custom un.dshPetPurgePageCreate un.dshPetPurgePageLeave

  Function un.dshPetPurgePageCreate
    ; 静默卸载不渲染页面：/PURGE（或 --delete-app-data）四项全删，否则一律保留
    ${If} ${Silent}
      Abort
    ${EndIf}

    !insertmacro MUI_HEADER_TEXT "选择要删除的用户数据" \
      "程序会被卸载。下面的数据默认全部保留 —— 只有勾选的才会被删除。"

    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ; 数据目录在这里算一次，写进说明文字（用户要能看清删的是哪个目录）
    !insertmacro dshPetDataDir $R0

    ; 页面可用区域约 300x134 单位：说明 20 + 四项各 28（勾选框 12 + 说明 16）。
    ; 说明行缩进到勾选框文字下方 —— 与勾选框本身占位重叠时字会糊成一团。
    ${NSD_CreateLabel} 0u 0u 300u 20u \
      "卸载会删除程序本身。以下用户数据默认全部保留；$\r$\n勾选的会被永久删除，无法恢复。"
    Pop $0

    ${NSD_CreateCheckBox} 0u 22u 300u 12u "对话记忆与配置"
    Pop $dshPetPageCheckData
    ${NSD_CreateLabel} 12u 34u 288u 16u \
      "$R0\dsh-pet\：配置、对话记忆、宠物包、自定义动画与表情包$\r$\n（不含 API 密钥与开机自启标记）"
    Pop $0

    ${NSD_CreateCheckBox} 0u 50u 300u 12u "AI 设置与 API 密钥"
    Pop $dshPetPageCheckAi
    ${NSD_CreateLabel} 12u 62u 288u 16u \
      "$R0\dsh-pet\standalone-ai.json：以明文保存的 API 密钥"
    Pop $0

    ${NSD_CreateCheckBox} 0u 78u 300u 12u "内置 Electron 运行时（约 348 MB）"
    Pop $dshPetPageCheckRuntime
    ${NSD_CreateLabel} 12u 90u 288u 16u \
      "$R0\electron\：DSH Pet 自带的 Electron，删除后其它程序不受影响"
    Pop $0

    ${NSD_CreateCheckBox} 0u 106u 300u 12u "桌面壳缓存（约 65 MB）"
    Pop $dshPetPageCheckCache
    ${NSD_CreateLabel} 12u 118u 288u 16u \
      "%APPDATA%\dsh-pet-electron-helper\ 与 %APPDATA%\DSH Pet\：窗口缓存与本地设置"
    Pop $0

    ; 默认全不勾（NSD_CreateCheckBox 本身默认未勾，这里显式写出来，防止以后有人改默认值）
    ${NSD_SetState} $dshPetPageCheckData ${BST_UNCHECKED}
    ${NSD_SetState} $dshPetPageCheckAi ${BST_UNCHECKED}
    ${NSD_SetState} $dshPetPageCheckRuntime ${BST_UNCHECKED}
    ${NSD_SetState} $dshPetPageCheckCache ${BST_UNCHECKED}

    nsDialogs::Show
  FunctionEnd

  Function un.dshPetPurgePageLeave
    ${NSD_GetState} $dshPetPageCheckData $dshPetPurgeData
    ${NSD_GetState} $dshPetPageCheckAi $dshPetPurgeAi
    ${NSD_GetState} $dshPetPageCheckRuntime $dshPetPurgeRuntime
    ${NSD_GetState} $dshPetPageCheckCache $dshPetPurgeCache
  FunctionEnd
!endif

; ---------------------------------------------------------------------------
; 安装前检查：应用正在运行时，**先明确告诉用户**再关闭它。
;
; 为什么必须覆盖默认实现：electron-builder 的 CHECK_APP_RUNNING 在发现应用在跑时会弹
; 「DSH Pet 正在运行，点击确定关闭」并等用户点。这在 MSI（msiwrapped 把本安装包封进 WiX）
; 里变成灾难：外层 MSI 没有界面，用户看到的是安装卡住/长时间无响应；而且开机自启让
; 「安装时应用正在运行」几乎必然发生。
;
; 这里换成：
;   1. 一句有人话上下文的确认框（说明会关闭、装完会重新启动）；
;   2. 用户同意后结束进程并等它退干净；
;   3. 用户取消 → 中止安装。
;
; 定义这个宏之后，electron-builder 的 CHECK_APP_RUNNING 会优先调用它（见
; allowOnlyOneInstallerInstance.nsh 的 !ifmacrodef customCheckAppRunning）。
; 注意两条容易踩的反直觉约定：
;   - 默认分支才会 insert IS_POWERSHELL_AVAILABLE，而 FIND_PROCESS / KILL_PROCESS 都依赖它
;     设置的 $IsPowerShellAvailable —— 自定义分支必须自己先 insert 一次；
;   - FIND_PROCESS 的返回值 **0 = 找到进程**（PowerShell 判到即 exit 0），非 0 才是没在跑。
; ---------------------------------------------------------------------------
!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  ; 先声明 KILL_PROCESS 用到的 $pid（默认分支由 _CHECK_APP_RUNNING 的 GetProcessInfo 声明；
  ; 走自定义分支时没有那一步，不声明会得到 warning 6000，而 electron-builder 把 warning 当错误）
  Var /GLOBAL pid
  StrCpy $pid 0
  !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
  ${If} $R0 == 0
    ; 静默安装（MSI 的 wrappedInstallerArgs、/S、CI）没有用户可点：不能弹框，
    ; 也不能因为应用关不掉就让安装挂住——直接结束进程继续装。
    ${IfNot} ${Silent}
      MessageBox MB_YESNO|MB_ICONQUESTION \
        "安装将关闭正在运行的 ${PRODUCT_NAME}，安装完成后会自动重新启动。$\r$\n$\r$\n继续安装吗？" \
        /SD IDYES IDYES closeRunningApp
      Quit ; 用户选择「否」：中止安装，不动正在运行的实例
    ${EndIf}

    closeRunningApp:
    !insertmacro KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 1
    Sleep 1000
    ; 给窗口/文件句柄一点时间释放，避免紧接着的写入撞上「文件正在使用」
    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 == 0
      Sleep 2000
    ${EndIf}
  ${EndIf}
!macroend

; 安装完成：默认开启开机自启（只对从未初始化过的用户生效）。
;
; 标记文件与 src/host/autostart.ts 的 `autostart-initialized` 是同一个：
;   - 不存在 → 用户从未初始化过：写 Run 项 + 写标记（应用首次启动不再重复处理）；
;   - 已存在 → 用户之前主动关掉过自启（或升级安装）：绝不写回，保持用户选择。
; 注册表写入失败时不写标记，让应用首次启动还能重试；安装本身不因自启失败而中断。
!macro customInstall
  Push $0
  ${IfNot} ${FileExists} "$PROFILE\.dsh\dsh-pet\autostart-initialized"
    ClearErrors
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.DSH Pet" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --autostart'
    ${IfNot} ${Errors}
      CreateDirectory "$PROFILE\.dsh\dsh-pet"
      FileOpen $0 "$PROFILE\.dsh\dsh-pet\autostart-initialized" w
      ${If} $0 != ""
        FileWrite $0 "installed by DSH Pet installer$\r$\n"
        FileClose $0
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $0
!macroend

!macro customUnInstall
  ${IfNot} ${isUpdated}
    Push $0
    Push $1
    Push $2

    ; -----------------------------------------------------------------------
    ; 升级保护到此为止：下面所有清理都只在「真正的卸载」里发生。
    ;
    ; 先算数据目录并存进 $dshPetHome：卸载段后面还要用它删自启标记，
    ; 而枚举注册表值时会反复覆写 $0-$2，不能每次都重新 ReadEnvStr。
    ; -----------------------------------------------------------------------
    !insertmacro dshPetDataDir $dshPetHome

    StrCpy $0 0
    ${Do}
      EnumRegValue $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" $0
      ${If} $1 == ""
        ${ExitDo}
      ${EndIf}
      ReadRegStr $2 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "$1"
      ${If} $2 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --autostart'
        DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "$1"
        DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "$1"
        ; 删除后后面的值前移：本次不递增索引，避免漏掉紧随其后的同名项
      ${Else}
        IntOp $0 $0 + 1
      ${EndIf}
    ${Loop}

    ; -----------------------------------------------------------------------
    ; 用户数据清理（ticket 02）
    ;
    ; 默认一个字节都不碰。勾选变量在页面 leave 回调里已经被写成 ${BST_CHECKED} /
    ; ${BST_UNCHECKED}；静默卸载或页面被跳过时它们是空串（从未赋值），这里一并归零。
    ; 随后命令行 /PURGE（不区分大小写）或 --delete-app-data → 四项全删：
    ; 后者是 electron-builder 自己注册的开关，两套名字共用一个语义，免得用户记两套。
    ;
    ; 每一项独立判断、删除前 ClearErrors：某项失败（文件被占用/权限不足）
    ; 不影响后面的项，更不会中断卸载 —— 卸载本身必须能走完。
    ; -----------------------------------------------------------------------
    ${If} $dshPetPurgeData == ""
      StrCpy $dshPetPurgeData 0
      StrCpy $dshPetPurgeAi 0
      StrCpy $dshPetPurgeRuntime 0
      StrCpy $dshPetPurgeCache 0
    ${EndIf}

    ${GetParameters} $R0
    ${GetOptions} $R0 "/PURGE" $R1
    ${IfNot} ${Errors}
      StrCpy $dshPetPurgeData ${BST_CHECKED}
      StrCpy $dshPetPurgeAi ${BST_CHECKED}
      StrCpy $dshPetPurgeRuntime ${BST_CHECKED}
      StrCpy $dshPetPurgeCache ${BST_CHECKED}
    ${Else}
      ${GetOptions} $R0 "--delete-app-data" $R1
      ${IfNot} ${Errors}
        StrCpy $dshPetPurgeData ${BST_CHECKED}
        StrCpy $dshPetPurgeAi ${BST_CHECKED}
        StrCpy $dshPetPurgeRuntime ${BST_CHECKED}
        StrCpy $dshPetPurgeCache ${BST_CHECKED}
      ${EndIf}
    ${EndIf}

    ; 1) 对话记忆与配置：只删 dsh-pet 目录，不含 electron 运行时；
    ;    standalone-ai.json 与 autostart-initialized 也在这个目录里，见下面两项。
    ${If} $dshPetPurgeData == ${BST_CHECKED}
      ClearErrors
      RMDir /r "$dshPetHome\dsh-pet"
    ${EndIf}

    ; 2) AI 设置与 API 密钥：明文密钥单列一项，让用户在删之前意识到它是什么。
    ;    即使没勾第 1 项也照样删（两项互不依赖）。
    ${If} $dshPetPurgeAi == ${BST_CHECKED}
      ClearErrors
      Delete "$dshPetHome\dsh-pet\standalone-ai.json"
    ${EndIf}

    ; 3) 内置 Electron 运行时（约 348 MB）。
    ${If} $dshPetPurgeRuntime == ${BST_CHECKED}
      ClearErrors
      RMDir /r "$dshPetHome\electron"
    ${EndIf}

    ; 4) 桌面壳缓存：两份 Chromium profile / userData。都是精确目录名，
    ;    不做 $APPDATA\dsh-pet* 这类通配，避免误删同前缀的其它软件。
    ${If} $dshPetPurgeCache == ${BST_CHECKED}
      ClearErrors
      RMDir /r "$APPDATA\dsh-pet-electron-helper"
      RMDir /r "$APPDATA\DSH Pet"
    ${EndIf}

    ; 自启初始化标记：与勾选无关，非升级卸载一律删除。
    ; 不删的话重装后应用以为「用户关过自启」，永远不再默认开启（ticket 17）。
    Delete "$dshPetHome\dsh-pet\autostart-initialized"

    Pop $2
    Pop $1
    Pop $0
  ${EndIf}
!macroend
