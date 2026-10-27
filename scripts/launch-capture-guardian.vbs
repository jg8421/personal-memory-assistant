Option Explicit
Dim shell,fs,root
Set shell=CreateObject("WScript.Shell")
Set fs=CreateObject("Scripting.FileSystemObject")
root=fs.GetParentFolderName(WScript.ScriptFullName)
shell.Run "wscript.exe //B //Nologo """ & root & "\launch-power-policy.vbs""",0,False
shell.Run "wscript.exe //B //Nologo """ & root & "\launch-tray.vbs""",0,False