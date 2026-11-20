; prt per-user setup. This file and build-setup.ps1 are intentionally ASCII.
; Data and papers are created by the application outside {app}; neither is
; listed as an installed file or an uninstall deletion target.
#ifndef AppVersion
  #error AppVersion must be supplied by desktop/build-setup.ps1
#endif
#ifndef AppId
  #define AppId "975952.prt"
#endif
#ifndef AppName
  #define AppName "prt"
#endif
#ifndef DefaultDir
  #define DefaultDir "{localappdata}\Programs\prt"
#endif
#ifndef SourceExe
  #error SourceExe must be supplied by desktop/build-setup.ps1
#endif
#ifndef SetupOutputDir
  #define SetupOutputDir "..\..\dist"
#endif

[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=prt contributors
AppPublisherURL=https://github.com/975952/prt
AppSupportURL=https://github.com/975952/prt/issues
AppUpdatesURL=https://github.com/975952/prt/releases/latest
DefaultDirName={#DefaultDir}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
AllowNoIcons=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#SetupOutputDir}
OutputBaseFilename=prt-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\prt.exe
Uninstallable=yes
ChangesAssociations=yes
CloseApplications=no
RestartApplications=no
RestartIfNeededByRun=no
SetupLogging=yes
VersionInfoVersion={#AppVersion}
VersionInfoDescription=prt Setup
VersionInfoProductName=prt
LicenseFile=..\..\LICENSE

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Registry]
Root: HKCU; Subkey: "Software\Classes\prt.Reader.PDF"; ValueType: string; ValueName: ""; ValueData: "prt PDF"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\prt.Reader.PDF\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\prt.exe"" ""%1"""
Root: HKCU; Subkey: "Software\Classes\.pdf\OpenWithProgids"; ValueType: string; ValueName: "prt.Reader.PDF"; ValueData: ""; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\prt\Capabilities"; ValueType: string; ValueName: "ApplicationName"; ValueData: "prt"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\prt\Capabilities"; ValueType: string; ValueName: "ApplicationDescription"; ValueData: "prt PDF reader"
Root: HKCU; Subkey: "Software\prt\Capabilities\FileAssociations"; ValueType: string; ValueName: ".pdf"; ValueData: "prt.Reader.PDF"
Root: HKCU; Subkey: "Software\RegisteredApplications"; ValueType: string; ValueName: "prt"; ValueData: "Software\prt\Capabilities"; Flags: uninsdeletevalue

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: unchecked

[Files]
Source: "{#SourceExe}"; DestDir: "{app}"; DestName: "prt.exe"; Flags: ignoreversion
Source: "prt-installed.flag"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\prt.exe"; WorkingDir: "{app}"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#AppName}"; Filename: "{app}\prt.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\prt.exe"; Description: "Open {#AppName}"; Flags: nowait postinstall skipifsilent; Check: CanLaunchReader

[Code]
var
  ImportOptions: TInputOptionWizardPage;
  ImportDirectory: TInputDirWizardPage;
  MigrationFailed: Boolean;
  MigrationFailure: String;
  MigrationSource: String;
  MigrationReport: String;

const
  RuntimeKey = 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  RuntimeDownload = 'https://developer.microsoft.com/microsoft-edge/webview2/';

function RuntimeInRegistry(Root: Integer): Boolean;
var
  Version: String;
begin
  Result := RegQueryStringValue(Root, RuntimeKey, 'pv', Version) and
    (Version <> '') and (Version <> '0.0.0.0');
end;

function HasWebView2: Boolean;
begin
  Result := RuntimeInRegistry(HKCU32) or RuntimeInRegistry(HKCU64) or
    RuntimeInRegistry(HKLM32) or RuntimeInRegistry(HKLM64);
end;

function InitializeSetup: Boolean;
var
  ErrorCode: Integer;
begin
  Result := HasWebView2;
  if not Result then begin
    Log('Microsoft Edge WebView2 Runtime is required and was not found.');
    if not WizardSilent then
      if MsgBox('prt needs Microsoft Edge WebView2 Runtime to display its window.' + #13#10#13#10 +
        'Setup will not download or run additional software. Open the official download page, install the Evergreen Runtime, and run this setup again?',
        mbInformation, MB_YESNO) = IDYES then
        ShellExec('open', RuntimeDownload, '', '', SW_SHOWNORMAL, ewNoWait, ErrorCode);
  end;
end;

procedure InitializeWizard;
begin
  ImportOptions := CreateInputOptionPage(wpSelectTasks,
    'Keep your reading library',
    'Existing installed data is kept when you upgrade.',
    'A new installation stores settings and conversations in Local AppData\prt\data, and papers in Documents\prt\papers. Uninstalling the app keeps both folders.' + #13#10#13#10 +
    'If you used the portable edition, you can copy its library now. Nothing in the old folder will be removed or overwritten.', False, False);
  ImportOptions.Add('Import from an old portable folder');
  ImportOptions.Values[0] := False;
  ImportDirectory := CreateInputDirPage(ImportOptions.ID,
    'Choose the old portable folder',
    'Select the folder that contains the old data and papers folders.',
    'Close the old reader first. Import only works with an empty destination; an existing library will never be overwritten. You can skip this step and run setup again later to import.', False, '');
  ImportDirectory.Add('Old portable folder:');
  MigrationSource := ExpandConstant('{param:MIGRATEFROM|}');
  if MigrationSource <> '' then begin
    ImportOptions.Values[0] := True;
    ImportDirectory.Values[0] := MigrationSource;
  end;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := (PageID = ImportDirectory.ID) and not ImportOptions.Values[0];
end;

function AbsoluteDirectory(const Directory: String): Boolean;
begin
  Result := ((Length(Directory) >= 3) and (Directory[2] = ':') and
    ((Directory[3] = '\') or (Directory[3] = '/'))) or
    ((Length(Directory) >= 3) and (Copy(Directory, 1, 2) = '\\'));
end;

function ValidateMigrationSource: String;
begin
  Result := '';
  if not ImportOptions.Values[0] then Exit;
  MigrationSource := Trim(ImportDirectory.Values[0]);
  if not AbsoluteDirectory(MigrationSource) or not DirExists(MigrationSource) then
    Result := 'Choose an existing absolute path for the old portable folder.'
  else if not DirExists(AddBackslash(MigrationSource) + 'data') and
    not DirExists(AddBackslash(MigrationSource) + 'papers') then
    Result := 'This folder does not contain data or papers. Choose the old portable application folder.'
  else if CompareText(RemoveBackslashUnlessRoot(MigrationSource), RemoveBackslashUnlessRoot(ExpandConstant('{app}'))) = 0 then
    Result := 'The old portable folder must be different from the installation folder.';
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  ErrorText: String;
begin
  Result := True;
  if CurPageID = ImportDirectory.ID then begin
    ErrorText := ValidateMigrationSource;
    Result := ErrorText = '';
    if not Result then MsgBox(ErrorText, mbError, MB_OK);
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := ValidateMigrationSource;
end;

function JsonError(const Json: String): String;
var
  Position, Index: Integer;
  Ch: Char;
  Escaped: Boolean;
begin
  Result := '';
  Position := Pos('"error"', Json);
  if Position = 0 then Exit;
  Index := Position + Length('"error"');
  while (Index <= Length(Json)) and (Json[Index] <> ':') do Index := Index + 1;
  Index := Index + 1;
  while (Index <= Length(Json)) and (Json[Index] <= ' ') do Index := Index + 1;
  if (Index > Length(Json)) or (Json[Index] <> '"') then Exit;
  Index := Index + 1;
  Escaped := False;
  while Index <= Length(Json) do begin
    Ch := Json[Index];
    if Escaped then begin
      if Ch = 'n' then Result := Result + #13#10
      else if Ch = 'r' then Result := Result + #13
      else if Ch = 't' then Result := Result + ' '
      else Result := Result + Ch;
      Escaped := False;
    end else if Ch = '\' then Escaped := True
    else if Ch = '"' then Exit
    else Result := Result + Ch;
    Index := Index + 1;
  end;
end;

function QuotePathArgument(const Value: String): String;
var
  Index: Integer;
begin
  { Windows command lines double a trailing backslash before the closing quote.
    This also handles a portable folder at a drive root, such as D:\. }
  Result := '"' + Value;
  Index := Length(Value);
  while (Index > 0) and (Value[Index] = '\') do begin
    Result := Result + '\';
    Index := Index - 1;
  end;
  Result := Result + '"';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ExitCode: Integer;
  Started: Boolean;
  ReportBytes: AnsiString;
  ReportText, Normalized: String;
begin
  if (CurStep <> ssPostInstall) or not ImportOptions.Values[0] then Exit;
  MigrationReport := ExpandConstant('{tmp}\prt-migration-report.json');
  WizardForm.StatusLabel.Caption := 'Copying the portable library...';
  Started := Exec(ExpandConstant('{app}\prt.exe'),
    '--migrate-from ' + QuotePathArgument(MigrationSource) + ' --report ' + QuotePathArgument(MigrationReport) + ' --silent',
    ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ExitCode);
  ReportText := '';
  if LoadStringFromFile(MigrationReport, ReportBytes) then ReportText := UTF8Decode(ReportBytes);
  Normalized := ReportText;
  StringChangeEx(Normalized, ' ', '', True);
  StringChangeEx(Normalized, #13, '', True);
  StringChangeEx(Normalized, #10, '', True);
  StringChangeEx(Normalized, #9, '', True);
  MigrationFailed := not Started or (ExitCode <> 0) or (Pos('"ok":true', Normalized) = 0);
  if MigrationFailed then begin
    MigrationFailure := JsonError(ReportText);
    if MigrationFailure = '' then MigrationFailure := 'The library import did not finish. Close the old reader and run setup again to retry the import.';
    Log('Portable import failed: ' + MigrationFailure);
    if not WizardSilent then MsgBox('The app is installed, but your library import needs attention.' + #13#10#13#10 +
      MigrationFailure + #13#10#13#10 + 'Your original portable folder has not been removed. The app will not be opened automatically.', mbError, MB_OK);
  end else Log('Portable library copied successfully. Original files kept.');
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = wpFinished) and MigrationFailed then begin
    WizardForm.FinishedHeadingLabel.Caption := 'Installed - library import needs attention';
    WizardForm.FinishedLabel.Caption := MigrationFailure + #13#10#13#10 +
      'Your original portable folder is still available. Close the old reader, then run setup again with the same import folder.';
  end;
end;

function CanLaunchReader: Boolean;
begin
  Result := not MigrationFailed;
end;

function GetCustomSetupExitCode: Integer;
begin
  if MigrationFailed then Result := 20 else Result := 0;
end;
