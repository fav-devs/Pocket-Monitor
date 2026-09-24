; OpenPocketCine viewfinder — Windows installer.
;
; Compiled by build-installer.ps1 with Inno Setup 6 after build-release.ps1 has staged
; the executable and every runtime DLL in target\release. The installer puts them in
; Program Files, registers the Media Foundation virtual camera source
; (opc_vcam_win.dll) so the Output tab's camera device is there from the first run,
; and unregisters it again on uninstall. Nothing is signed.

#ifndef Staged
  #define Staged "..\target\release"
#endif
#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
#ifndef OutDir
  #define OutDir "..\dist"
#endif

[Setup]
AppId={{6F0B4C1E-8D7A-4F3B-9C2E-5A1D7E9B3C41}
AppName=OpenPocketCine
AppVersion={#AppVersion}
AppVerName=OpenPocketCine {#AppVersion}
AppPublisher=OpenPocketCine contributors
AppPublisherURL=https://github.com/fav-devs/OpenPocketCine
AppSupportURL=https://github.com/fav-devs/OpenPocketCine/issues
DefaultDirName={autopf}\OpenPocketCine
DefaultGroupName=OpenPocketCine
DisableProgramGroupPage=yes
OutputDir={#OutDir}
OutputBaseFilename=OpenPocketCine-Setup-{#AppVersion}
SetupIconFile=viewfinder.ico
UninstallDisplayIcon={app}\viewfinder.ico
UninstallDisplayName=OpenPocketCine
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; The camera source registers under HKLM, which needs an administrator.
PrivilegesRequired=admin
MinVersion=10.0.19041
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#Staged}\opc-monitor.exe"; DestDir: "{app}"; Flags: ignoreversion
; The Swift facade and runtime, the allocator, FFmpeg: everything the executable loads.
Source: "{#Staged}\*.dll"; DestDir: "{app}"; Excludes: "opc_vcam_win.dll"; Flags: ignoreversion
; The virtual camera source: a COM server the Camera Frame Server loads. `regserver`
; registers it on install (the same as the Output tab's Install) and unregisters it on
; uninstall; `noregerror` keeps a failed registration from failing the whole install,
; since the tab can register it again later.
Source: "{#Staged}\opc_vcam_win.dll"; DestDir: "{app}"; Flags: ignoreversion regserver noregerror
Source: "{#Staged}\FFmpeg-LICENSE.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "viewfinder.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\..\THIRD-PARTY-NOTICES.md"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist
Source: "..\..\..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist

[Icons]
Name: "{group}\OpenPocketCine"; Filename: "{app}\opc-monitor.exe"; Parameters: "view"; IconFilename: "{app}\viewfinder.ico"; WorkingDir: "{app}"
Name: "{group}\Uninstall OpenPocketCine"; Filename: "{uninstallexe}"
Name: "{autodesktop}\OpenPocketCine"; Filename: "{app}\opc-monitor.exe"; Parameters: "view"; IconFilename: "{app}\viewfinder.ico"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\opc-monitor.exe"; Parameters: "view"; Description: "{cm:LaunchProgram,OpenPocketCine}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; The operator's settings and media cache stay; only what the installer put down goes.
Type: filesandordirs; Name: "{app}"
