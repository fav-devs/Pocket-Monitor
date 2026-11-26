; Pocket Monitor (the Tauri app, crates/pm-desktop): Windows installer.
;
; Compiled by build-tauri-installer.ps1 with Inno Setup 6 after build-tauri-release.ps1 has
; staged pocket-monitor.exe and every runtime DLL in target\pm-release.
;
; It replaces the old opc-monitor build in place: the AppId, the install folder and the
; shortcut names are the old installer's (OpenPocketCine.iss), so an existing install is
; upgraded rather than installed twice, and settings and the media cache in
; %LOCALAPPDATA%\OpenPocketCine are left alone (both builds read them). It registers the
; Media Foundation virtual camera source (opc_vcam_win.dll) as before, unregisters it on
; uninstall, and installs the Microsoft Edge WebView2 Runtime when the PC lacks it (the
; app's interface is a web view). Nothing is signed.

#ifndef Staged
  #define Staged "..\target\pm-release"
#endif
#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
#ifndef OutDir
  #define OutDir "..\dist\tauri"
#endif
#ifndef WebView2Bootstrapper
  #define WebView2Bootstrapper "MicrosoftEdgeWebview2Setup.exe"
#endif

[Setup]
; The old installer's AppId: upgrades an opc-monitor install in place.
AppId={{6F0B4C1E-8D7A-4F3B-9C2E-5A1D7E9B3C41}
AppName=Pocket Monitor
AppVersion={#AppVersion}
AppVerName=Pocket Monitor {#AppVersion}
AppPublisher=Pocket Monitor contributors
AppPublisherURL=https://github.com/fav-devs/Pocket-Monitor
AppSupportURL=https://github.com/fav-devs/Pocket-Monitor/issues
DefaultDirName={autopf}\OpenPocketCine
DefaultGroupName=Pocket Monitor
DisableProgramGroupPage=yes
OutputDir={#OutDir}
OutputBaseFilename=PocketMonitor-Setup-{#AppVersion}
SetupIconFile=viewfinder.ico
UninstallDisplayIcon={app}\viewfinder.ico
UninstallDisplayName=Pocket Monitor
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; The camera source registers under HKLM, and WebView2 installs machine-wide: administrator.
PrivilegesRequired=admin
MinVersion=10.0.19041
; Closes a running Pocket Monitor (old or new) before replacing its files.
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[InstallDelete]
; The old egui/Slint viewfinder this build replaces, and the logs it tried to write here.
Type: files; Name: "{app}\opc-monitor.exe"
Type: files; Name: "{app}\opc-monitor.log"
Type: files; Name: "{app}\opc-ble.log"

[Files]
Source: "{#Staged}\pocket-monitor.exe"; DestDir: "{app}"; Flags: ignoreversion
; The Swift facade and runtime, the allocator, FFmpeg: everything the executable loads.
Source: "{#Staged}\*.dll"; DestDir: "{app}"; Excludes: "opc_vcam_win.dll"; Flags: ignoreversion
; ffmpeg.exe (the same LGPL shared build) drives webcam gestures (D8).
Source: "{#Staged}\ffmpeg.exe"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist
; The virtual camera source: a COM server the Camera Frame Server loads. `regserver`
; registers it on install (the same as the Output tab's Install) and unregisters it on
; uninstall; `noregerror` keeps a failed registration from failing the whole install,
; since the tab can register it again later.
Source: "{#Staged}\opc_vcam_win.dll"; DestDir: "{app}"; Flags: ignoreversion regserver noregerror
Source: "{#Staged}\FFmpeg-LICENSE.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "viewfinder.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\..\THIRD-PARTY-NOTICES.md"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist
Source: "..\..\..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist
Source: "..\..\..\NOTICE"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist
; The Evergreen WebView2 bootstrapper (about 2 MB): run only when the runtime is missing.
Source: "{#WebView2Bootstrapper}"; DestDir: "{tmp}"; DestName: "MicrosoftEdgeWebview2Setup.exe"; Flags: deleteafterinstall; Check: NeedsWebView2

[Icons]
; The Start-menu and desktop entries open the home screen (A1), as before; a second
; launch while the app runs brings its window forward instead of opening another.
Name: "{group}\Pocket Monitor"; Filename: "{app}\pocket-monitor.exe"; IconFilename: "{app}\viewfinder.ico"; WorkingDir: "{app}"
Name: "{group}\Uninstall Pocket Monitor"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Pocket Monitor"; Filename: "{app}\pocket-monitor.exe"; IconFilename: "{app}\viewfinder.ico"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{tmp}\MicrosoftEdgeWebview2Setup.exe"; Parameters: "/silent /install"; StatusMsg: "Installing the Microsoft Edge WebView2 Runtime..."; Flags: waituntilterminated; Check: NeedsWebView2
Filename: "{app}\pocket-monitor.exe"; Description: "{cm:LaunchProgram,Pocket Monitor}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; The operator's settings, logs and media cache stay (%LOCALAPPDATA%\OpenPocketCine);
; only what the installer put down goes.
Type: filesandordirs; Name: "{app}"

[Code]
const
  WebView2Client = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function WebView2Version(Root: Integer; Key: String): String;
var
  Version: String;
begin
  Result := '';
  if RegQueryStringValue(Root, Key + WebView2Client, 'pv', Version) then
    if (Version <> '') and (Version <> '0.0.0.0') then
      Result := Version;
end;

{ The Evergreen runtime registers machine-wide (WOW6432Node on x64) or per user. }
function NeedsWebView2: Boolean;
begin
  Result :=
    (WebView2Version(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\') = '') and
    (WebView2Version(HKLM, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\') = '') and
    (WebView2Version(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\') = '');
end;
